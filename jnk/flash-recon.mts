// Recon for the Morpho flash liquidator scope:
//  1. real liquidatable Morpho positions on Base (size + market params)
//  2. exit venue depth for their collateral (Aerodrome V2/Slipstream, UniV3)
//  3. does our RPC support eth_call state overrides (code + stateDiff)?
//  4. flash-lender balances (informational — Morpho's own callback may not need one)
// Run: ./node_modules/.bin/tsx jnk/flash-recon.mts
import "dotenv/config";
import { createPublicClient, http, parseAbi, type Abi } from "viem";
import { base } from "viem/chains";
import { GraphQLClient } from "graphql-request";
import { v2Quote, v3Quote } from "../src/lib/prices.js";

const RPC = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const USDC = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as const;
const WETH = (process.env.WETH_ADDRESS ?? "0x4200000000000000000000000000000000000006") as const;
const AERO_V2_FACTORY = (process.env.DEX_V2_FACTORY ?? "0x420DD381b31aEf6683db6B902084cB0FFECe40Da") as const;
const SLIPSTREAM_FACTORY = (process.env.DEX_V3_FACTORY ?? "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A") as const;
const UNIV3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
const BALANCER = (process.env.BALANCER_VAULT ?? "0xBA12222222228d8Ba445958a75a0704d566BF2C8") as const;

const MORPHO_ABI = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function flashLoan(address token, uint256 assets, bytes data)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const V2_FACTORY_ABI = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CL_FACTORY_ABI = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const V2_POOL_ABI = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

async function main() {
  const block = await client.getBlockNumber();
  console.log(`Base block ${block}`);

  // ── 1. liquidatable positions ──────────────────────────────────────────────
  const gql = new GraphQLClient("https://api.morpho.org/graphql");
  const q = `
    query($first:Int!,$skip:Int!) {
      marketPositions(first:$first,skip:$skip,where:{healthFactor_lte:1.0,chainId_in:[8453]}) {
        items {
          id healthFactor
          market { marketId lltv irmAddress oracle { address } loanAsset { address symbol decimals } collateralAsset { address symbol decimals } }
          user { address }
          state { borrowAssets borrowAssetsUsd collateral collateralUsd }
        }
      }
    }`;
  const items: any[] = [];
  for (let skip = 0; skip < 400 && items.length < 60; skip += 100) {
    try {
      const d: any = await gql.request(q, { first: 100, skip });
      items.push(...d.marketPositions.items);
    } catch (e) { console.log("subgraph page failed:", String(e).slice(0, 120)); break; }
  }
  items.sort((a, b) => Number(b.state.borrowAssetsUsd) - Number(a.state.borrowAssetsUsd));
  console.log(`\nliquidatable positions fetched: ${items.length}`);
  const usable = items.filter((i) => Number(i.state.borrowAssetsUsd) >= 500 && i.market?.marketId);
  console.log(`with borrow >= $500 and market.address: ${usable.length}`);

  // ── 2. market params + exact amounts for the top few ───────────────────────
  const targets = usable.slice(0, 3);
  for (const it of targets) {
    const id = it.market.marketId as `0x${string}`;
    const params = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
    const pos = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [id, it.user.address] });
    const m = await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [id] });
    const oraclePrice = await client.readContract({ address: params[2], abi: ORACLE_ABI, functionName: "price" }).catch(() => null);
    const [loanDec, collDec] = await Promise.all([
      client.readContract({ address: params[0], abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: params[1], abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    const borrowed = (pos[1] * m[2]) / m[1]; // shares -> assets, round down (approx)
    const collUsd = (Number(pos[2]) * Number(oraclePrice ?? 0)) / 1e36;
    console.log(`\n  borrower ${it.user.address}  HF=${Number(it.healthFactor).toFixed(4)}`);
    console.log(`    market ${id} lltv=${Number(params[4]) / 1e18}`);
    console.log(`    loan=${params[0]} (${loanDec}d) coll=${params[1]} (${collDec}d) oracle=${params[2]} irm=${params[3]}`);
    console.log(`    borrowShares=${pos[1]} coll=${pos[2]} (${collUsd.toFixed(0)} USD by oracle) borrowed≈${Number(borrowed) / 10 ** loanDec} (subgraph: $${it.state.borrowAssetsUsd})`);
    console.log(`    market totals: borrow=${Number(m[2]) / 10 ** loanDec} supply=${Number(m[0]) / 10 ** loanDec}`);
  }

  // ── 3. exit venue depth for each target's collateral ───────────────────────
  for (const it of targets) {
    const coll = it.market.collateralAsset.address as `0x${string}`;
    const sym = it.market.collateralAsset.symbol;
    const dec = Number(it.market.collateralAsset.decimals);
    console.log(`\n  venues for ${sym} (${coll}), depth USD one-sided:`);

    // Aerodrome V2
    for (const stable of [true, false]) {
      for (const [qAddr, qSym, qDec] of [[USDC, "USDC", 6], [WETH, "WETH", 18]] as const) {
        try {
          const pool = await client.readContract({ address: AERO_V2_FACTORY, abi: V2_FACTORY_ABI, functionName: "getPool", args: [coll, qAddr, stable] });
          if (pool === "0x0000000000000000000000000000000000000000") continue;
          const [r, t0] = await Promise.all([
            client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: "getReserves" }),
            client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: "token0" }),
          ]);
          const { priceUsd, depthUsd } = v2Quote(r as any, dec, qDec, (t0 as string).toLowerCase() === coll.toLowerCase(), qSym === "USDC" ? 1 : 2600);
          console.log(`    aero-v2 ${sym}/${qSym} ${stable ? "stable" : "volatile"} pool=${pool} price=$${priceUsd.toFixed(4)} depth=$${depthUsd.toFixed(0)}`);
        } catch { /* no pool */ }
      }
    }
    // Slipstream (aerodrome CL) + Uniswap V3
    for (const [label, factory, abi, tiers] of [
      ["slipstream", SLIPSTREAM_FACTORY, CL_FACTORY_ABI, [100, 200, 500, 1000]],
      ["univ3", UNIV3_FACTORY, V3_FACTORY_ABI, [100, 500, 3000, 10000]],
    ] as const) {
      for (const fee of tiers) {
        for (const [qAddr, qSym, qDec] of [[USDC, "USDC", 6], [WETH, "WETH", 18]] as const) {
          try {
            const pool = await client.readContract({ address: factory, abi: abi as Abi, functionName: "getPool", args: [coll, qAddr, fee as any] });
            if (pool === "0x0000000000000000000000000000000000000000") continue;
            const [s0, liq, t0] = await Promise.all([
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" }),
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "token0" }),
            ]);
            const { priceUsd, depthUsd } = v3Quote((s0 as any)[0], liq as any, dec, qDec, (t0 as string).toLowerCase() === coll.toLowerCase(), qSym === "USDC" ? 1 : 2600);
            console.log(`    ${label} ${sym}/${qSym} fee=${fee} pool=${pool} price=$${priceUsd.toFixed(4)} depth=$${depthUsd.toFixed(0)}`);
          } catch { /* no pool */ }
        }
      }
    }
  }

  // WETH→USDC hop depth (for 2-hop exits)
  try {
    const pool = await client.readContract({ address: UNIV3_FACTORY, abi: V3_FACTORY_ABI, functionName: "getPool", args: [WETH, USDC, 500] });
    if (pool !== "0x0000000000000000000000000000000000000000") {
      const [s0, liq, t0] = await Promise.all([
        client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
        client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "token0" }),
      ]);
      const { depthUsd } = v3Quote((s0 as any)[0], liq as any, 18, 6, (t0 as string).toLowerCase() === WETH.toLowerCase(), 1);
      console.log(`\n  univ3 WETH/USDC 0.05% pool=${pool} depth=$${depthUsd.toFixed(0)}`);
    }
  } catch (e) { console.log("weth/usdc read failed", String(e).slice(0, 100)); }

  // ── 4. eth_call state-override support (code + stateDiff) ──────────────────
  const SCRATCH = "0x1337133713371337133713371337133713371337" as const;
  // runtime: PUSH1 0 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN  -> returns storage[0]
  const RUNTIME = "0x60005460005260206000f3" as const;
  try {
    const r1: any = await client.call({
      to: SCRATCH, data: "0x",
      stateOverride: [{ address: SCRATCH, code: RUNTIME, stateDiff: [{ slot: "0x" + "0".repeat(64), value: "0x" + "2a".padStart(64, "0") }] }],
    });
    console.log(`\nstateOverride code+stateDiff: OK, returns ${BigInt(r1.data ?? "0x0")}`);
  } catch (e) {
    console.log(`\nstateOverride code+stateDiff: FAILED (${String(e).slice(0, 160)})`);
    try {
      const r2: any = await client.call({
        to: SCRATCH, data: "0x",
        stateOverride: [{ address: SCRATCH, code: RUNTIME }],
      });
      console.log(`  code-only override: OK (returns ${BigInt(r2.data ?? "0x0")}); stateDiff unsupported`);
    } catch (e2) { console.log(`  code-only override also failed: ${String(e2).slice(0, 160)}`); }
  }

  // ── 5. flash-lender balances (informational) ───────────────────────────────
  const [balUsdc, morphoUsdc] = await Promise.all([
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [BALANCER] }),
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [MORPHO] }),
  ]).catch(() => [0n, 0n]);
  console.log(`\nUSDC balance: Balancer vault=${(Number(balUsdc) / 1e6).toFixed(0)}  Morpho=${(Number(morphoUsdc) / 1e6).toFixed(0)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
