// Flash-free Morpho liquidation SIMULATION via eth_call state overrides.
//
// There is no profitable liquidatable position on Base right now (the unhealthy
// set is long-tail junk with $2 exit depth), so we take a real, *healthy*
// position and push it 0.2% underwater by overriding exactly one Morpho storage
// slot (position[id][borrower].collateral). Everything else is live mainnet
// state: Morpho's oracle, its liquidation math, the exit pools, and our
// contract (code injected at a scratch address).
//
// Exit liquidity is the binding constraint on Base (pool `liquidity()` across a
// narrow tick band vastly overstates real depth), so candidate routes are NOT
// trusted from a depth model — each one is tested with a real eth_call and the
// actual proceeds are read back from the revert. repaidShares is also ladder-
// stepped down (full -> 10%) until a route produces proceeds >= repaid: the
// largest executable liquidation is reported.
//
// Proves end-to-end: liquidate -> collateral-first transfer -> callback swap ->
// repay, with ZERO pre-funded capital.
//
// Run: ./node_modules/.bin/tsx jnk/flash-sim.mts
// Env: SIM_RPC, SIM_COLLATERALS (addr,addr priority list)
import "dotenv/config";
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbi, decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { base } from "viem/chains";
import { GraphQLClient } from "graphql-request";
import { readFileSync } from "node:fs";

const RPC = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const SCRATCH = "0x1337133713371337133713371337133713371337" as const;
const CALLER = "0x1111111111111111111111111111111111111111" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// candidate exit pools (from jnk/pool-discover.mts)
const U3_WETH_USDC_3000 = "0x6c561B446416E1A00E8E93E221854d6eA4171372" as const;
const U3_WETH_USDC_500 = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as const;
const U3_WETH_USDC_100 = "0xb4CB800910B228ED3d0834cF79D697127BBB00e5" as const;
const U3_WETH_USDC_10000 = "0x0b1C2DCbBfA744ebD3fC17fF1A96A1E1Eb4B2d69" as const;
const U3_CBETH_WETH_100 = "0xA9DaFa443a02FBc907Cb0093276B3E6F4ef02A46" as const;
const U3_CBETH_WETH_500 = "0x10648BA41B8565907Cfa1496765fA4D95390aa0d" as const;
const U3_CBETH_WETH_3000 = "0x7B9636266734270DE5bE02544c04E27046903ff8" as const;
const U3_CBETH_USDC_3000 = "0xa8E4C55D6dAf4D768aeBa2378c1AD94c112Ef48a" as const;

type Hop = readonly [pool: string, inToken: string, outToken: string];
const ROUTES: Record<string, { name: string; hops: Hop[] }[]> = {
  weth: [
    { name: "univ3 WETH/USDC f3000", hops: [[U3_WETH_USDC_3000, WETH, USDC]] },
    { name: "univ3 WETH/USDC f500", hops: [[U3_WETH_USDC_500, WETH, USDC]] },
    { name: "univ3 WETH/USDC f100", hops: [[U3_WETH_USDC_100, WETH, USDC]] },
    { name: "univ3 WETH/USDC f10000", hops: [[U3_WETH_USDC_10000, WETH, USDC]] },
  ],
  cbeth: [
    { name: "univ3 cbETH/WETH f100 -> WETH/USDC f3000", hops: [[U3_CBETH_WETH_100, CBETH, WETH], [U3_WETH_USDC_3000, WETH, USDC]] },
    { name: "univ3 cbETH/WETH f100 -> WETH/USDC f500", hops: [[U3_CBETH_WETH_100, CBETH, WETH], [U3_WETH_USDC_500, WETH, USDC]] },
    { name: "univ3 cbETH/WETH f500 -> WETH/USDC f3000", hops: [[U3_CBETH_WETH_500, CBETH, WETH], [U3_WETH_USDC_3000, WETH, USDC]] },
    { name: "univ3 cbETH/WETH f3000 -> WETH/USDC f3000", hops: [[U3_CBETH_WETH_3000, CBETH, WETH], [U3_WETH_USDC_3000, WETH, USDC]] },
    { name: "univ3 cbETH/USDC f3000 (direct)", hops: [[U3_CBETH_USDC_3000, CBETH, USDC]] },
  ],
};

const MORPHO_ABI = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const POOL_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);

const artifact = JSON.parse(readFileSync("contracts/out/MorphoFlashLiquidator.json", "utf8")) as { abi: any; bytecode: Hex; deployedBytecode: Hex };
const POSITION_MAPPING_SLOT = 2n; // Morpho.sol storage: owner(0), feeRecipient(1), position(2)

function slotOf(id: Hex, borrower: string): bigint {
  const h1 = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POSITION_MAPPING_SLOT]));
  const h2 = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [borrower as `0x${string}`, h1]));
  return BigInt(h2);
}

function revertData(e: any): Hex | undefined {
  let cur = e;
  for (let i = 0; i < 8 && cur; i++) {
    const d = cur.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d as Hex;
    cur = cur.cause;
  }
  return undefined;
}

const usd = (raw: bigint, dec: number) => `$${(Number(raw) / 10 ** dec).toFixed(2)}`;

async function main() {
  const gql = new GraphQLClient("https://api.morpho.org/graphql");
  const collateralList = (process.env.SIM_COLLATERALS ?? `${WETH},${CBETH}`).split(",").map((s) => s.trim());

  // ── 1. find a real healthy position (priority collateral, biggest borrow) ──
  let id: Hex | undefined, borrower: `0x${string}` | undefined, target: any;
  for (const coll of collateralList) {
    const mk: any = await gql.request(
      `query($c:[String!]!) { markets(first: 50, where: {collateralAssetAddress_in: $c,
         loanAssetAddress_in: ["${USDC}"], borrowAssetsUsd_gte: 50000, chainId_in: [8453]}) {
        items { marketId collateralAsset { symbol } state { borrowAssetsUsd } } } }`,
      { c: [coll] },
    );
    if (!mk.markets.items.length) continue;
    const ids: string[] = mk.markets.items.map((x: any) => x.marketId);
    const sym = mk.markets.items[0].collateralAsset.symbol.toLowerCase();
    if (!ROUTES[sym]) continue;
    const pd: any = await gql.request(
      `query($ids:[String!]!) {
         marketPositions(first: 100, where: {marketUniqueKey_in: $ids, healthFactor_gte: 1.0, chainId_in: [8453]}) {
           items { healthFactor market { marketId } user { address } state { borrowAssetsUsd } } } }`,
      { ids },
    );
    const cands = pd.marketPositions.items
      .filter((i: any) => Number(i.state.borrowAssetsUsd) >= 10000)
      .sort((a: any, b: any) => Number(b.state.borrowAssetsUsd) - Number(a.state.borrowAssetsUsd));
    if (!cands.length) continue;
    id = cands[0].market.marketId;
    borrower = cands[0].user.address;
    target = cands[0];
    console.log(`collateral=${cands[0].market.marketId && sym} routes=${ROUTES[sym].length} positions>= $10k: ${cands.length}`);
    break;
  }
  if (!id || !borrower || !target) throw new Error("no usable market/position found");
  console.log(`target: ${borrower}  subgraph HF=${Number(target.healthFactor).toFixed(4)}  borrow=$${Math.round(Number(target.state.borrowAssetsUsd))}`);

  // ── 2. on-chain market params, position, oracle ────────────────────────────
  const params = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
  const pos = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [id, borrower] });
  const m = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [id] });
  const price = await client.readContract({ address: params[2], abi: ORACLE_ABI, functionName: "price" });
  const [loanToken, collateralToken, , , lltv] = params;
  const collSym = collateralToken.toLowerCase() === WETH.toLowerCase() ? "WETH" : "cbETH";
  const loanDec = 6; // USDC
  const collDec = 18;
  console.log(`market params: loan=${loanToken} coll=${collateralToken} oracle=${params[2]} irm=${params[3]}`);
  console.log(`lltv=${Number(lltv) / 1e18}  borrowShares=${pos[1]}  collateral=${pos[2]}  oraclePrice=${price}`);

  const totalBorrowAssets = m[2], totalBorrowShares = m[3];
  const borrowedUp = (pos[1] * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares; // ceil
  const maxBorrowNow = ((((pos[2] * price) / 10n ** 36n) * lltv) / 10n ** 18n);
  console.log(`borrowed (ceil) = ${usd(borrowedUp, loanDec)} | maxBorrow now = ${usd(maxBorrowNow, loanDec)} | HF=${Number(maxBorrowNow) / Number(borrowedUp)}`);

  // ── 3. push the position 0.2% underwater via one storage slot ──────────────
  // unhealthy  <=>  collateral * price / 1e36 * lltv < borrowed
  // boundary   <=>  collateralB = borrowed * 1e36 * 1e18 / (price * lltv)
  const boundary = (borrowedUp * 10n ** 36n * 10n ** 18n) / (price * lltv);
  const targetCollateral = (boundary * 998n) / 1000n; // HF ~= 0.998
  if (targetCollateral >= pos[2]) throw new Error("position not healthy enough to need surgery?");
  console.log(`collateral: ${pos[2]} -> ${targetCollateral} (boundary ${boundary}, HF target ~0.998)`);

  const packedSlot = slotOf(id, borrower) + 1n; // supplyShares @ +0, {borrowShares,collateral} @ +1
  const packedNow = await client.getStorageAt({ address: MORPHO, slot: packedSlot });
  if (!packedNow) throw new Error("no storage read");
  const packedNowB = BigInt(packedNow);
  // verify packing hypothesis against the position() view (low 128 / high 128)
  const low128 = packedNowB & ((1n << 128n) - 1n);
  const high128 = packedNowB >> 128n;
  const order =
    low128 === BigInt(pos[1]) && high128 === BigInt(pos[2])
      ? "borrowShares|collateral"
      : low128 === BigInt(pos[2]) && high128 === BigInt(pos[1])
        ? "collateral|borrowShares"
        : null;
  if (!order) throw new Error(`packed slot ${packedSlot} does not match position() view: low=${low128} high=${high128}`);
  console.log(`packed slot verified: ${order} (slot 0x${packedSlot.toString(16)})`);
  const newPacked =
    order === "borrowShares|collateral"
      ? low128 | (targetCollateral << 128n)
      : targetCollateral | (high128 << 128n);

  // ── 4. candidate routes, verified hop-by-hop on-chain ──────────────────────
  const routes = ROUTES[collSym.toLowerCase()];
  if (!routes) throw new Error(`no route table for ${collSym}`);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const verified: { name: string; hops: { pool: `0x${string}`; zeroForOne: boolean }[] }[] = [];
  for (const r of routes) {
    let expectedIn: string | null = collateralToken;
    const hops: { pool: `0x${string}`; zeroForOne: boolean }[] = [];
    let ok = true;
    for (const [pool, inTok, outTok] of r.hops) {
      if (expectedIn && !eq(expectedIn, inTok)) ok = false;
      try {
        const [t0, t1] = await Promise.all([
          client.readContract({ address: pool as `0x${string}`, abi: POOL_ABI, functionName: "token0" }),
          client.readContract({ address: pool as `0x${string}`, abi: POOL_ABI, functionName: "token1" }),
        ]);
        const pairOk = (eq(t0, inTok) && eq(t1, outTok)) || (eq(t0, outTok) && eq(t1, inTok));
        if (!pairOk) ok = false;
        hops.push({ pool: pool as `0x${string}`, zeroForOne: eq(t0, inTok) });
      } catch {
        ok = false;
      }
      expectedIn = outTok;
    }
    if (!ok) {
      console.log(`route SKIP (verify failed): ${r.name}`);
      continue;
    }
    verified.push({ name: r.name, hops });
    console.log(`route ok: ${r.name}  ${r.hops.map(([p, i, o]) => `${i.slice(0, 6)}→${o.slice(0, 6)}@${p.slice(0, 8)}`).join(" -> ")}`);
  }
  if (!verified.length) throw new Error("no verifiable routes");

  const word = (v: bigint | string) => (typeof v === "string" ? v : `0x${v.toString(16).padStart(64, "0")}`) as Hex;
  const addrWord = (a: string) => word(BigInt(a));
  const stateOverride = [
    {
      address: SCRATCH,
      code: artifact.deployedBytecode,
      stateDiff: [
        { slot: word(0n), value: addrWord(CALLER) }, // owner
        { slot: word(1n), value: addrWord(MORPHO) }, // morpho
      ],
    },
    { address: MORPHO, stateDiff: [{ slot: word(packedSlot), value: word(newPacked) }] },
  ];

  // ── 5. ladder down repaidShares; every attempt is a real eth_call ─────────
  const fracs = [100n, 50n, 25n, 10n, 5n, 1n]; // % of full borrowShares
  console.log(`\neth_call ${RPC} — empirical route/size matrix:`);
  let passed: { name: string; frac: bigint; seized: bigint; repaid: bigint; profit: bigint } | null = null;
  outer: for (const f of fracs) {
    const repaidShares = (pos[1] * f) / 100n;
    if (repaidShares === 0n) continue;
    for (const route of verified) {
      const data = encodeFunctionData({
        abi: artifact.abi,
        functionName: "executeLiquidation",
        args: [{ loanToken, collateralToken, oracle: params[2], irm: params[3], lltv }, borrower, repaidShares, route.hops, 0n],
      } as any);
      try {
        const res = await client.call({ account: CALLER, to: SCRATCH, data, stateOverride });
        const [seized, repaid, profit] = decodeFunctionResult({
          abi: artifact.abi,
          functionName: "executeLiquidation",
          data: res.data as Hex,
        }) as bigint[];
        console.log(`  ${f}%  ${route.name}: SUCCESS`);
        passed = { name: route.name, frac: f, seized, repaid, profit };
        break outer;
      } catch (e: any) {
        const rd = revertData(e);
        let note = rd ? `revert ${rd.slice(0, 10)}` : String(e?.shortMessage ?? e).slice(0, 60);
        if (rd?.startsWith("0x7b268179")) {
          // InsufficientProceeds(balance, repaid, ins, outs)
          try {
            const dec = decodeErrorResult({ abi: artifact.abi, data: rd });
            const [bal, rep] = dec.args as bigint[];
            note = `proceeds ${usd(bal, loanDec)} < repaid ${usd(rep, loanDec)}`;
          } catch { /* keep raw */ }
        } else if (rd?.startsWith("0x08c379a0")) {
          note = `Error(${rd.slice(10 + 64 + 64, 10 + 64 + 64 + 2 + Number(BigInt("0x" + rd.slice(10 + 64, 10 + 64 + 64))) * 2)})`;
        } else if (rd) {
          try {
            const dec = decodeErrorResult({ abi: artifact.abi, data: rd });
            const args = JSON.stringify(dec.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
            note = `${dec.errorName}${args.length > 120 ? args.slice(0, 120) + "…" : args}`;
          } catch { /* keep raw */ }
        }
        console.log(`  ${f}%  ${route.name}: ${note}`);
      }
    }
  }

  if (!passed) throw new Error("every route/size attempt failed — no executable exit at this position");
  console.log("\n=== SIMULATION SUCCEEDED (eth_call, no state persisted) ===");
  console.log(`  route             : ${passed.name} @ ${passed.frac}% of position`);
  console.log(`  seized collateral : ${Number(passed.seized) / 1e18} ${collSym}`);
  console.log(`  repaid            : ${usd(passed.repaid, loanDec)}   (flash capital that was NOT needed)`);
  console.log(`  net profit        : ${usd(passed.profit, loanDec)}`);
  console.log(`  capital required  : $0 (Morpho transferred collateral before the repay was pulled)`);
}

main().catch((e) => {
  const data = revertData(e);
  if (data) {
    try {
      const dec = decodeErrorResult({ abi: artifact.abi, data });
      console.error("revert:", dec.errorName, JSON.stringify(dec.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    } catch {
      console.error("revert data:", data);
    }
  }
  console.error(String(e?.shortMessage ?? e?.message ?? e).slice(0, 800));
  process.exit(1);
});
