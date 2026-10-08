// jnk/self-liq.mts — LIVE settled Morpho liquidation on Base.
//
// Why self: the full on-chain sweep (jnk/target-scan.mts) found 0 executable
// external targets — best exit in the whole market is 88% of repay — and
// Morpho health-checks every borrow/withdrawCollateral, so the only way to
// execute a real production-path liquidation *today* is with ourselves as the
// borrower. Morpho market creation is permissionless: we create a market with
// our own oracle, borrow against WETH, drop our oracle price below HF 1, then
// run the deployed MorphoFlashLiquidator.executeLiquidation() — real Morpho
// liquidate, real univ3 swap (WETH/USDC f3000), real callback, real profit.
//
// Victim: us. Cost: swap fee (0.3%) + gas, ~$0.15. The "profit" is recycled
// own collateral. Purpose: prove end-to-end live execution with one tx.
//
//   ./node_modules/.bin/tsx jnk/self-liq.mts [--dry]
//
// --dry: run all prep txs, dry-run executeLiquidation, stop before the send.
// Resumable via /tmp/opencode/self-liq-state.json (oracle address).
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  decodeFunctionResult,
  decodeEventLog,
  decodeErrorResult,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.SEND_RPC ?? "https://base.drpc.org";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372"; // univ3 WETH/USDC f3000
const REAL_WETH_ORACLE = "0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const ONE18 = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const LLTV = 860_000_000_000_000_000n; // 0.86 (enabled on Base)
const WRAP_ETH = 11_000_000_000_000_000n; // 0.011 ETH → WETH collateral
const SUPPLY_USDC = 30_000_000n; // loan-side liquidity
const BORROW_USDC = 15_000_000n;
const HF_TARGET_WAD = 920_000_000_000_000_000n; // HF 0.92 (<1, and > lltv/f≈0.824 → full-repay branch)
const MIN_PROFIT = 8_000_000n; // $8 USDC — exercises the Unprofitable gate live
const DRY = process.argv.includes("--dry");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const WETH_ABI = parseAbi(["function deposit() payable"]);
const ORACLE_ABI = parseAbi([
  "function price() view returns (uint256)",
  "function setPrice(uint256)",
]);
const MORPHO_ABI = parseAbi([
  "function createMarket((address,address,address,address,uint256))",
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function withdraw((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function isIrmEnabled(address) view returns (bool)",
  "function isLltvEnabled(uint256) view returns (bool)",
]);
const LIQ_ABI = parseAbi([
  "function executeLiquidation((address,address,address,address,uint256),address,uint256,(address,bool)[],uint256) returns (uint256,uint256,uint256)",
  "function withdraw(address)",
  "event Liquidated(address indexed borrower, address indexed loanToken, address indexed collateralToken, uint256 seizedCollateral, uint256 repaidAssets, uint256 profit)",
  "error NotOwner()",
  "error NotMorpho()",
  "error NotExecuting()",
  "error Reentrancy()",
  "error BadRoute()",
  "error UnexpectedPool()",
  "error WrongDirection()",
  "error InsufficientProceeds(uint256 balance, uint256 repaid)",
  "error Unprofitable(uint256 profit, uint256 minProfit)",
  "error TransferFailed(address token, address to, uint256 amount, bool ok, bytes ret)",
  "error ApproveFailed(bytes ret)",
]);
const MORPHO_ERRORS = parseAbi([
  "error MARKET_NOT_CREATED()",
  "error MARKET_ALREADY_CREATED()",
  "error IRM_NOT_ENABLED()",
  "error LLTV_NOT_ENABLED()",
  "error INCONSISTENT_INPUT()",
  "error ZERO_ASSETS()",
  "error ZERO_ADDRESS()",
  "error UNAUTHORIZED()",
  "error HEALTHY_POSITION()",
  "error INSUFFICIENT_COLLATERAL()",
  "error INSUFFICIENT_LIQUIDITY()",
  "error NOT_CONTRACT()",
]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const pk = (process.env.PRIVATE_KEY ?? "").trim();
if (!pk) throw new Error("PRIVATE_KEY missing in .env");
const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });

const LIQ = (process.env.FLASH_LIQUIDATOR ?? "").trim() as `0x${string}`;
const oracleArtifact = JSON.parse(readFileSync("contracts/out/TestPriceOracle.json", "utf8")) as {
  abi: unknown[]; bytecode: Hex; deployedBytecode: Hex;
};

const STATE_PATH = "/tmp/opencode/self-liq-state.json";
let state: { oracle?: `0x${string}`; marketId?: Hex; completed?: boolean } = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : {};
if (state.completed) state = {};
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

let gasSpent = 0n;
const usdc$ = (x: bigint) => `$${Number(formatUnits(x, 6)).toFixed(4)}`;
const usdc2$ = (x: bigint) => `$${Number(formatUnits(x, 6)).toFixed(2)}`;
const weth = (x: bigint) => `${Number(formatUnits(x, 18)).toFixed(6)} WETH`;
/** oracle-scale price ($ × 1e24) → "$2571.50" */
const ethUsd = (p: bigint) => `$${(Number(p) / 1e24).toFixed(2)}`;

function decodeRevert(raw: unknown): string {
  const data = typeof raw === "string" ? raw : typeof (raw as any)?.data === "string" ? (raw as any).data : undefined;
  if (!data || data === "0x") return "no revert data";
  try {
    const e = decodeErrorResult({ abi: [...LIQ_ABI, ...MORPHO_ERRORS] as any, data: data as Hex });
    return `${e.errorName}(${(e.args ?? []).join(",")})`;
  } catch {
    return `raw ${String(data).slice(0, 34)}…`;
  }
}

async function send(label: string, request: any): Promise<any> {
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}: tx reverted — ${hash}`);
  gasSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  console.log(`  ✓ ${label}  block ${receipt.blockNumber} gas ${receipt.gasUsed}`);
  return receipt;
}

/** simulateContract (eth_call dry-run) then broadcast. Retries on RPC-node lag: after a
 *  just-sent tx, a load-balanced node may not have seen it yet (allowance reads stale). */
async function step(label: string, params: any): Promise<any> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { request } = await publicClient.simulateContract({ account, ...params });
      return await send(label, request);
    } catch (e: any) {
      lastErr = e;
      if (attempt < 3) {
        console.log(`  · ${label}: attempt ${attempt} failed (${e?.shortMessage ?? e?.message}) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const raw = e?.data ?? e?.cause?.data ?? (typeof e?.walk === "function" ? e.walk((c: any) => c?.data) : undefined);
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      const detail = raw !== undefined ? ` — revert ${decodeRevert(raw)}` : "";
      throw new Error(`${label}: ${msg}${detail}`);
    }
  }
  throw new Error(`${label}: ${lastErr?.message}`);
}

const readPos = (id: Hex) =>
  publicClient.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [id, account.address] }) as Promise<readonly [bigint, bigint, bigint]>;
const readMkt = (id: Hex) =>
  publicClient.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [id] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;

async function main() {
  console.log(`self-liq: signer ${account.address}  rpc ${RPC}`);
  if (!LIQ) throw new Error("FLASH_LIQUIDATOR missing in .env — run jnk/deploy.mts first");

  // ── preflight ────────────────────────────────────────────────────────────
  const [eth0, usdc0, weth0, liqCode, token0, realPrice, irmOk, lltvOk] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBytecode({ address: LIQ }),
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" }),
    publicClient.readContract({ address: REAL_WETH_ORACLE, abi: ORACLE_ABI, functionName: "price" }),
    publicClient.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "isIrmEnabled", args: [ZERO_ADDR] }),
    publicClient.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "isLltvEnabled", args: [LLTV] }),
  ]);
  if (!liqCode) throw new Error(`no code at ${LIQ} — run jnk/deploy.mts first`);
  if (token0.toLowerCase() !== WETH.toLowerCase()) throw new Error(`pool token0 ${token0} != WETH — wrong pool`);
  if (!irmOk) throw new Error("IRM address(0) not enabled on Base");
  if (!lltvOk) throw new Error("LLTV 0.86 not enabled on Base");
  const hfAtReal = (((WRAP_ETH * realPrice) / ORACLE_SCALE) * LLTV) / BORROW_USDC;
  console.log(`  liquidator ${LIQ}  USDC ${usdc$(usdc0)}  WETH ${weth(weth0)}  ETH ${Number(formatUnits(eth0, 18)).toFixed(6)}`);
  console.log(`  real WETH ${ethUsd(realPrice)} → borrow-time HF ≈ ${Number(hfAtReal) / 1e18} (borrow needs >1)`);

  // market id depends on the oracle, so the oracle comes first:
  // ── 1. deploy our oracle ─────────────────────────────────────────────────
  if (!state.oracle || !(await publicClient.getBytecode({ address: state.oracle }))) {
    const hash = await wallet.deployContract({
      abi: oracleArtifact.abi as any,
      bytecode: oracleArtifact.bytecode,
      args: [realPrice, account.address],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("oracle deploy failed");
    gasSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    state.oracle = receipt.contractAddress;
    saveState();
    console.log(`  ✓ TestPriceOracle deployed at ${state.oracle} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  } else console.log(`  · oracle ${state.oracle} already deployed`);

  // ── 3. create the market ─────────────────────────────────────────────────
  // tuple values must be arrays: the parseAbi signatures use anonymous tuples
  const oracleAddr = state.oracle!;
  const params = [USDC, WETH, oracleAddr, ZERO_ADDR, LLTV] as const; // MarketParams
  const marketId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      params,
    ),
  );
  state.marketId = marketId;
  saveState();
  const existing = await readMkt(marketId);
  if (existing[4] === 0n) {
    await step("Morpho.createMarket(USDC/WETH, our oracle, irm=0, lltv=.86)", {
      address: MORPHO, abi: MORPHO_ABI, functionName: "createMarket", args: [params],
    });
  } else console.log(`  · market ${marketId} already created`);

  // ── 4. supply USDC ───────────────────────────────────────────────────────
  let pos = await readPos(marketId);
  if (pos[0] === 0n) {
    const usdcBal = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    if (usdcBal < SUPPLY_USDC) throw new Error(`USDC balance ${usdc$(usdcBal)} < ${usdc$(SUPPLY_USDC)} needed`);
    const allow = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [account.address, MORPHO] });
    if (allow < SUPPLY_USDC) await step("USDC.approve(Morpho, 30)", { address: USDC, abi: ERC20_ABI, functionName: "approve", args: [MORPHO, SUPPLY_USDC] });
    await step(`supply ${usdc$(SUPPLY_USDC)} loan liquidity`, {
      address: MORPHO, abi: MORPHO_ABI, functionName: "supply", args: [params, SUPPLY_USDC, 0n, account.address, "0x"],
    });
  } else console.log(`  · already supplied (shares ${pos[0]})`);

  // ── 5. wrap + supply WETH collateral ─────────────────────────────────────
  pos = await readPos(marketId);
  if (pos[2] === 0n) {
    let wBal = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    if (wBal < WRAP_ETH) {
      await step("wrap 0.011 ETH → WETH", { address: WETH, abi: WETH_ABI, functionName: "deposit", value: WRAP_ETH });
    }
    const allow = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "allowance", args: [account.address, MORPHO] });
    if (allow < WRAP_ETH) await step("WETH.approve(Morpho, 0.011)", { address: WETH, abi: ERC20_ABI, functionName: "approve", args: [MORPHO, WRAP_ETH] });
    await step(`supplyCollateral ${weth(WRAP_ETH)}`, {
      address: MORPHO, abi: MORPHO_ABI, functionName: "supplyCollateral", args: [params, WRAP_ETH, account.address, "0x"],
    });
  } else console.log(`  · already supplied collateral (${weth(pos[2])})`);

  // ── 6. borrow USDC ───────────────────────────────────────────────────────
  pos = await readPos(marketId);
  if (pos[1] === 0n) {
    await step(`borrow ${usdc$(BORROW_USDC)}`, {
      address: MORPHO, abi: MORPHO_ABI, functionName: "borrow", args: [params, BORROW_USDC, 0n, account.address, account.address],
    });
  } else console.log(`  · already borrowed (shares ${pos[1]})`);

  // ── 7. drop our oracle price → HF < 1 ────────────────────────────────────
  pos = await readPos(marketId);
  let mkt = await readMkt(marketId);
  for (let i = 0; i < 4 && (pos[1] === 0n || mkt[3] === 0n); i++) {
    await new Promise((r) => setTimeout(r, 1500)); // RPC node lag after the borrow tx
    pos = await readPos(marketId);
    mkt = await readMkt(marketId);
  }
  if (pos[1] === 0n || mkt[3] === 0n) throw new Error("no borrow position — cannot continue");
  const debtNow = (pos[1] * mkt[2] + mkt[3] - 1n) / mkt[3];
  const readPrice = () => publicClient.readContract({ address: oracleAddr, abi: ORACLE_ABI, functionName: "price" }) as Promise<bigint>;
  const hfOf = (p: bigint) => (((pos[2] * p) / ORACLE_SCALE) * LLTV) / debtNow;
  let price = await readPrice();
  if (hfOf(price) >= ONE18) {
    const target = (HF_TARGET_WAD * debtNow * ORACLE_SCALE) / (LLTV * pos[2]);
    await step(`oracle.setPrice(${ethUsd(target)}) → HF 0.92`, {
      address: oracleAddr, abi: ORACLE_ABI, functionName: "setPrice", args: [target],
    });
  } else console.log(`  · oracle already dropped`);
  // poll until we read the dropped price (load-balanced RPC nodes can lag behind the just-sent tx)
  let hfAfter = ONE18;
  for (let i = 0; i < 5; i++) {
    price = await readPrice();
    hfAfter = hfOf(price);
    if (hfAfter < ONE18) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const fWad = (10n ** 36n) / (ONE18 - ((ONE18 - LLTV) * 3n) / 10n); // 1/(1−0.3(1−lltv))
  console.log(`  oracle ${ethUsd(price)} → HF ${Number(hfAfter) / 1e18} (need <1; full-repay branch needs > ${Number((LLTV * ONE18) / fWad) / 1e18})`);
  if (hfAfter >= ONE18) throw new Error("still healthy after setPrice — cannot liquidate");

  // ── 8. size the liquidation from on-chain truth ──────────────────────────
  pos = await readPos(marketId);
  let mkt2 = await readMkt(marketId);
  for (let i = 0; i < 4 && (pos[1] === 0n || mkt2[3] === 0n); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    pos = await readPos(marketId);
    mkt2 = await readMkt(marketId);
  }
  const debt = (pos[1] * mkt2[2] + mkt2[3] - 1n) / mkt2[3]; // ceil
  const collValue = (pos[2] * price) / ORACLE_SCALE;
  const debtF = (debt * fWad) / ONE18;
  let repaidShares: bigint;
  let repay: bigint;
  let branch: string;
  if (collValue < debtF) {
    repay = (collValue * ONE18) / fWad;
    repaidShares = (pos[1] * repay) / debt;
    branch = "coll-capped (seize all, partial repay)";
  } else {
    repay = debt;
    repaidShares = pos[1];
    branch = "debt-capped (full repay, partial seize)";
  }
  console.log(`  debt ${usdc$(debt)}  collateral ${weth(pos[2])} (oracle ${usdc$(collValue)})  f=${Number(fWad) / 1e18}`);
  console.log(`  branch: ${branch} → repaidShares ${repaidShares}/${pos[1]}  repay ${usdc$(repay)}`);
  if (repaidShares === 0n) throw new Error("repaidShares = 0");

  // ── 9. dry-run the production call ───────────────────────────────────────
  const hops = [[POOL, true]] as const; // Hop tuples: token0 = WETH (verified in preflight)
  const argsExec = [params, account.address, repaidShares, hops, MIN_PROFIT] as const;
  const calldata = encodeFunctionData({ abi: LIQ_ABI, functionName: "executeLiquidation", args: argsExec as any });
  let ret: Hex | undefined;
  let dryErr: unknown;
  for (let attempt = 1; attempt <= 4 && !ret; attempt++) {
    try {
      const res = await publicClient.call({ account: account.address, to: LIQ, data: calldata });
      ret = res.data!;
    } catch (e: any) {
      dryErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500)); // node lag → may not see setPrice yet
    }
  }
  if (!ret) {
    const data = (dryErr as any)?.data ?? (dryErr as any)?.cause?.data;
    throw new Error(`dry-run reverted — ${decodeRevert(data)}${(dryErr as any)?.shortMessage ? ` (${(dryErr as any).shortMessage})` : ""}`);
  }
  const [seized, repaid, profit] = decodeFunctionResult(LIQ_ABI, "executeLiquidation", ret) as [bigint, bigint, bigint];
  console.log(`\nDRY-RUN OK: seized ${weth(seized)} → repaid ${usdc$(repaid)} → profit ${usdc$(profit)} (minProfit ${usdc$(MIN_PROFIT)})`);
  if (profit < MIN_PROFIT) throw new Error(`dry-run profit ${usdc$(profit)} < minProfit`);
  if (DRY) { console.log("--dry: stopping before the live send"); return; }

  // ── 10. the live trade ───────────────────────────────────────────────────
  console.log(`\nlive send — executeLiquidation …`);
  const receipt = await step("executeLiquidation (REAL TX)", {
    address: LIQ, abi: LIQ_ABI, functionName: "executeLiquidation", args: argsExec,
  });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== LIQ.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: LIQ_ABI, data: log.data, topics: log.topics });
      const a = ev.args as any;
      console.log(`  event Liquidated: seized ${weth(a.seizedCollateral)} repaid ${usdc$(a.repaidAssets)} profit ${usdc$(a.profit)}`);
    } catch { /* not ours */ }
  }

  // ── 11. collect: contract profit + supplier claim + leftover collateral ──
  const liqBal = (await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [LIQ] })) as bigint;
  if (liqBal > 0n) {
    await step(`liquidator.withdraw(USDC) ${usdc$(liqBal)} → owner`, {
      address: LIQ, abi: LIQ_ABI, functionName: "withdraw", args: [USDC],
    });
  }
  pos = await readPos(marketId);
  if (pos[0] > 0n) {
    await step(`withdraw supply (shares ${pos[0]})`, {
      address: MORPHO, abi: MORPHO_ABI, functionName: "withdraw", args: [params, 0n, pos[0], account.address, account.address],
    });
  }
  pos = await readPos(marketId);
  if (pos[2] > 0n) {
    await step(`withdrawCollateral remainder ${weth(pos[2])}`, {
      address: MORPHO, abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [params, pos[2], account.address, account.address],
    });
  }

  // ── report ───────────────────────────────────────────────────────────────
  const [eth1, usdc1, weth1] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  const gasEth = Number(formatUnits(gasSpent, 18));
  console.log(`\n──── RESULT ─────────────────────────────────────────────`);
  console.log(`settled liquidation: ${receipt.transactionHash}  block ${receipt.blockNumber}`);
  console.log(`  seized ${weth(seized)} → repaid ${usdc$(repaid)} → profit ${usdc$(profit)} (own collateral, recycled)`);
  console.log(`gas this run: ${gasEth.toFixed(6)} ETH (~$${(gasEth * 2500).toFixed(3)})`);
  console.log(`USDC ${usdc$(usdc0)} → ${usdc$(usdc1)}   WETH ${weth(weth0)} → ${weth(weth1)}   ETH ${Number(formatUnits(eth1, 18)).toFixed(6)}`);
  console.log(`true cost = swap fee + gas; profit figure above is our own WETH sold through the pool`);
  state.completed = true;
  saveState();
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  console.error("state saved — rerun to resume from the last successful step.");
  process.exit(1);
});
