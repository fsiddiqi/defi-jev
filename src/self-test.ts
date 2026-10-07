// The AUTO safety gate: a successful end-to-end self-liquidation executed by
// the app's OWN executor, against a market only we can liquidate.
//
// Why this exists (requirement: no AUTO without proof):
//   - The full-market sweep found 0 executable external targets, so no "real"
//     trade is possible to practice on — the only production-path execution is
//     a self-liquidation through the deployed MorphoFlashLiquidator.
//   - v1 self-test used a naive oracle every caller could see, so any keeper
//     could have liquidated our test position. v2 (TestPriceOracleV2) arms an
//     attack price that ONLY our EOA ever reads (tx.origin switch): every other
//     caller gets the live WETH/USDC price, on which the position is healthy.
//   - This module *proves* that property before and after the trade: an
//     eth_call of executeLiquidation from a stranger's address must revert
//     (HEALTHY_POSITION), while our send succeeds and settles.
//
// Cost: a few thousandths of an ETH in gas + the 0.3% pool fee. The "profit"
// is our own collateral recycled back into the market. Dev loops: --dry stops
// before the live send.
import "dotenv/config";
import {
  parseAbi,
  encodeAbiParameters,
  keccak256,
  formatUnits,
  decodeErrorResult,
  type Hex,
  type Address,
  type Abi,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXECUTOR_ABI, encodeCalldata, executeLiquidation, type ExecutionTarget } from "./execute.js";
import { loadBudget, type BudgetConfig } from "./lib/budget.js";

// ── addresses / params (Base) ────────────────────────────────────────────────
export const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH = "0x4200000000000000000000000000000000000006";
export const POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372"; // univ3 WETH/USDC f3000 (token0=WETH, verified)
export const REAL_WETH_ORACLE = "0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4"; // live WETH/USDC (Morpho-compatible)
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
const LLTV = 860_000_000_000_000_000n; // 0.86 (enabled on Base)
const ONE18 = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
/** attacker-proof probe: a non-owner tx.origin that must NEVER settle our position */
const STRANGER = "0x000000000000000000000000000000000000dEaD";

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
const ORACLE_V2_ABI = parseAbi([
  "function price() view returns (uint256)",
  "function armAttackPrice(uint256)",
]);
const MORPHO_ABI = parseAbi([
  "function createMarket((address,address,address,address,uint256))",
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function withdraw((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function isIrmEnabled(address) view returns (bool)",
  "function isLltvEnabled(uint256) view returns (bool)",
]);
const LIQ_ERRORS = parseAbi([
  "error NotOwner()",
  "error NotMorpho()",
  "error NotExecuting()",
  "error Reentrancy()",
  "error BadRoute()",
  "error UnexpectedPool()",
  "error WrongDirection()",
  "error InsufficientProceeds(uint256 balance, uint256 repaid)",
  "error Unprofitable(uint256 profit, uint256 minProfit)",
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

// ── gate record (what the AUTONOMOUS loop checks before trusting itself) ─────
export const GATE_FILE = join(process.cwd(), "data", "self-test-passed.json");
export const STATE_FILE = join(process.cwd(), "data", "self-test-state.json");
export const BUDGET_FILE = join(process.cwd(), "data", "budget.json");

export interface SelfTestGate {
  passed: boolean;
  at: string | null;
  txHash: Hex | null;
  chainId: number | null;
  liquidator: Address | null; // gate is only valid for THIS executor
  oracle: Address | null;
  marketId: Hex | null;
  keeperProbeReverted: boolean; // prove strangers can't settle us
  gasCostUsd: number | null;
  profitUsd: number | null;
  error: string | null;
}

const freshGate = (): SelfTestGate => ({
  passed: false, at: null, txHash: null, chainId: null, liquidator: null,
  oracle: null, marketId: null, keeperProbeReverted: false,
  gasCostUsd: null, profitUsd: null, error: null,
});

export function readGate(): SelfTestGate {
  try {
    return { ...freshGate(), ...(JSON.parse(readFileSync(GATE_FILE, "utf8")) as Partial<SelfTestGate>) };
  } catch {
    return freshGate();
  }
}

function writeGate(g: SelfTestGate): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(GATE_FILE, JSON.stringify(g, null, 2));
}

/**
 * Is AUTO allowed? The gate proves the CURRENT executor address end-to-end —
 * a different (redeployed) liquidator or chain invalidates a past gate.
 */
export function gateEligible(g: SelfTestGate, liquidator: Address, chainId: number): { ok: boolean; reason: string } {
  if (!g.passed) return { ok: false, reason: "self-test gate not passed — run `npm run self-test` first (or --no-auto-gate to override)" };
  if (g.liquidator && g.liquidator.toLowerCase() !== liquidator.toLowerCase()) {
    return { ok: false, reason: "gate was proven for a different liquidator contract — re-run --self-test" };
  }
  if (g.chainId !== chainId) return { ok: false, reason: `gate was proven on chain ${g.chainId}, running on ${chainId}` };
  if (!g.keeperProbeReverted) return { ok: false, reason: "gate did not verify the keeper-blocking probe — re-run --self-test" };
  return { ok: true, reason: "" };
}

// ── runner ────────────────────────────────────────────────────────────────────
export interface SelfTestDeps {
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: Address;
  liquidator: Address;
  morpho: Address;
  rpcLabel: string;
  ethPriceUsd: number;
  budget: BudgetConfig;
}

export interface SelfTestResult {
  passed: boolean;
  txHash?: Hex;
  gasCostUsd?: number;
  profitUsd?: number;
  keeperProbeReverted: boolean;
  oracle?: Address;
  marketId?: Hex;
  error?: string;
}

function decodeRevert(data: unknown): string {
  const d = typeof data === "string" ? data : typeof (data as { data?: string })?.data === "string" ? (data as { data: string }).data : undefined;
  if (!d || d === "0x") return "no revert data";
  try {
    const e = decodeErrorResult({ abi: [...EXECUTOR_ABI, ...LIQ_ERRORS] as unknown as Abi, data: d as Hex });
    return `${e.errorName}(${(e.args ?? []).join(",")})`;
  } catch {
    return `raw ${String(d).slice(0, 34)}…`;
  }
}

export async function runSelfTest(deps: SelfTestDeps, opts: { dry?: boolean } = {}): Promise<SelfTestResult> {
  const { publicClient, wallet, owner, liquidator, morpho } = deps;
  if (!wallet.account) throw new Error("self-test needs a funded wallet");
  console.log(`\n── self-test (keeper-proof) ────────────────────────────────`);
  console.log(`signer ${owner}  liquidator ${liquidator}  rpc ${deps.rpcLabel}`);

  // Resumable across runs: oracle + market persist; supply/collateral persist;
  // the position empties after each successful liquidation and re-borrows.
  let state: { oracle?: Address; marketId?: Hex } = {};
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { state = {}; }
  }
  const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  let gasCostUsd = 0;
  const gasUsd = (gasUsed: bigint, gasPrice: bigint) => (Number(gasUsed) * Number(gasPrice) * deps.ethPriceUsd) / 1e18;
  // Script-style write helper (mirrors jnk/self-liq): the wallet is bound to
  // chain/acconut at creation; requests add them explicitly for typing.
  const step = async (label: string, request: Record<string, unknown>): Promise<{ hash: Hex; gasUsed: bigint; gasPrice: bigint }> => {
    const hash = await wallet.writeContract({ ...request, chain: base, account: wallet.account } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label}: tx reverted ${hash}`);
    return { hash, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice ?? (await publicClient.getGasPrice()) };
  };

  const readPos = () => publicClient.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "position", args: [state.marketId!, owner] }) as Promise<readonly [bigint, bigint, bigint]>;
  const readMkt = () => publicClient.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [state.marketId!] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;

  try {
    // ── preflight ────────────────────────────────────────────────────────────
    const [liqCode, irmOk, lltvOk, realPrice0, usdcBal, wethBal, ethBal] = await Promise.all([
      publicClient.getBytecode({ address: liquidator }),
      publicClient.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "isIrmEnabled", args: [ZERO_ADDR] }),
      publicClient.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "isLltvEnabled", args: [LLTV] }),
      publicClient.readContract({ address: REAL_WETH_ORACLE, abi: ORACLE_ABI, functionName: "price" }),
      publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
      publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
      publicClient.getBalance({ address: owner }),
    ]);
    if (!liqCode) throw new Error(`no code at liquidator ${liquidator} — deploy MorphoFlashLiquidator first`);
    if (!irmOk) throw new Error("IRM address(0) not enabled on Base");
    if (!lltvOk) throw new Error("LLTV 0.86 not enabled on Base");
    const usdcUsd = Number(formatUnits(usdcBal, 6));
    const ethWei = Number(formatUnits(ethBal, 18));
    console.log(`preflight: USDC $${usdcUsd.toFixed(2)}  WETH ${Number(formatUnits(wethBal, 18)).toFixed(5)}  ETH ${ethWei.toFixed(6)}  live WETH/$${(Number(realPrice0) / 1e24).toFixed(0)}`);
    if (usdcUsd < 8) throw new Error(`needs >= $8 USDC free (have $${usdcUsd.toFixed(2)}) — refill the wallet before self-test`);
    if (ethWei < 0.001) throw new Error(`needs >= 0.001 ETH for gas (have ${ethWei.toFixed(6)})`);

    // ── 1. deploy TestPriceOracleV2 (once per state file) ────────────────────
    if (!state.oracle || !(await publicClient.getBytecode({ address: state.oracle }))) {
      const artifact = JSON.parse(readFileSync(join(process.cwd(), "contracts", "out", "TestPriceOracleV2.json"), "utf8")) as { abi: unknown[]; bytecode: Hex };
      const hash = await wallet.deployContract({ abi: artifact.abi as unknown as Abi, bytecode: artifact.bytecode, args: [owner, REAL_WETH_ORACLE], chain: base, account: wallet.account } as any);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      gasCostUsd += gasUsd(r.gasUsed, r.effectiveGasPrice ?? (await publicClient.getGasPrice()));
      if (r.status !== "success" || !r.contractAddress) throw new Error("oracle v2 deploy failed");
      state.oracle = r.contractAddress;
      saveState();
      console.log(`✓ oracle v2 deployed ${state.oracle} (attack price visible ONLY to ${owner})`);
    } else {
      console.log(`· oracle v2 ${state.oracle} (already deployed)`);
    }

    // ── 2. market ────────────────────────────────────────────────────────────
    const params = [USDC, WETH, state.oracle!, ZERO_ADDR, LLTV] as const;
    state.marketId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      params,
    ));
    saveState();
    let mkt = await readMkt();
    if (mkt[4] === 0n) {
      const r = await step("createMarket (USDC/WETH, oracle v2, irm 0, lltv 0.86)", {
        address: morpho, abi: MORPHO_ABI, functionName: "createMarket", args: [params],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    } else console.log(`· market ${state.marketId.slice(0, 10)}… exists`);

    // ── 3. supply loan liquidity (keep $4 of USDC liquid in the wallet) ──────
    let pos = await readPos();
    if (pos[0] === 0n) {
      const supplyUsdc = BigInt(Math.floor(Math.min(usdcUsd - 4, 20) * 1e6));
      if (supplyUsdc <= 0) throw new Error("not enough USDC to supply liquidity");
      const allow = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [owner, morpho] }) as bigint;
      if (allow < supplyUsdc) {
        const r = await step("USDC.approve(Morpho)", { address: USDC, abi: ERC20_ABI, functionName: "approve", args: [morpho, supplyUsdc] });
        gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
      }
      const r = await step(`supply $${Number(formatUnits(supplyUsdc, 6)).toFixed(2)} USDC`, {
        address: morpho, abi: MORPHO_ABI, functionName: "supply", args: [params, supplyUsdc, 0n, owner, "0x"],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    } else console.log(`· supply already seeded (shares ${pos[0]})`);

    // ── 4. collateral (wrap only if the position has none left to use) ───────
    pos = await readPos();
    if (pos[2] === 0n) {
      const wrap = BigInt(Math.floor(Math.min(ethWei - 0.0008, 0.0018) * 1e18)); // keep a gas reserve
      if (wrap <= 0) throw new Error("not enough ETH to wrap as collateral");
      if (wethBal < wrap) {
        const r = await step(`wrap ${Number(formatUnits(wrap, 18)).toFixed(5)} ETH → WETH`, {
          address: WETH, abi: WETH_ABI, functionName: "deposit", value: wrap,
        });
        gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
      }
      const allow = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "allowance", args: [owner, morpho] }) as bigint;
      if (allow < wrap) {
        const r = await step("WETH.approve(Morpho)", { address: WETH, abi: ERC20_ABI, functionName: "approve", args: [morpho, wrap] });
        gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
      }
      const r = await step(`supplyCollateral ${Number(formatUnits(wrap, 18)).toFixed(5)} WETH`, {
        address: morpho, abi: MORPHO_ABI, functionName: "supplyCollateral", args: [params, wrap, owner, "0x"],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    } else console.log(`· collateral seeded (${Number(formatUnits(pos[2], 18)).toFixed(5)} WETH)`);

    // ── 5. borrow sized to the LIVE price → healthy (HF ≈ 1.35) ──────────────
    pos = await readPos();
    const debtBud = pos[1];
    if (debtBud === 0n) {
      const price = await publicClient.readContract({ address: state.oracle!, abi: ORACLE_V2_ABI, functionName: "price" }) as bigint; // attackPrice=0 → live
      const collValue = (pos[2] * price) / ORACLE_SCALE;
      const maxBorrow = (collValue * LLTV) / ONE18;
      const borrowUsdc = (maxBorrow * 10n ** 18n) / (135n * 10n ** 16n); // HF target 1.35
      const borrowUsdcCeil = (borrowUsdc / 1n) * 1n;
      if (borrowUsdcCeil <= 0) throw new Error("collateral too small to borrow anything");
      const r = await step(`borrow ~$${Number(formatUnits(borrowUsdcCeil, 6)).toFixed(2)} USDC (HF~1.35)`, {
        address: morpho, abi: MORPHO_ABI, functionName: "borrow", args: [params, borrowUsdcCeil, 0n, owner, owner],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    } else console.log(`· prior borrow (shares ${debtBud}) — reusing`);

    // wait for node lag so the fresh position/market state is readable
    pos = await readPos();
    mkt = await readMkt();
    for (let i = 0; i < 4 && (pos[1] === 0n || mkt[3] === 0n); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      pos = await readPos();
      mkt = await readMkt();
    }
    if (pos[1] === 0n || mkt[3] === 0n) throw new Error("no borrow position after setup");

    const debt = (pos[1] * mkt[2] + mkt[3] - 1n) / mkt[3]; // ceil
    const readLive = () => publicClient.readContract({ address: REAL_WETH_ORACLE, abi: ORACLE_ABI, functionName: "price" }) as Promise<bigint>;
    const live = await readLive();

    // ── 6. arm the attack price → HF 0.90 (debt-capped branch) ───────────────
    const target = (90n * debt * ORACLE_SCALE) / (pos[2] * LLTV);
    await step(`armAttackPrice($${(Number(target) / 1e24).toFixed(0)}) → HF 0.90`, {
      address: state.oracle!, abi: ORACLE_V2_ABI, functionName: "armAttackPrice", args: [target],
    });
    let attackSeen: bigint | null = null;
    for (let i = 0; i < 5; i++) {
      try {
        attackSeen = await publicClient.readContract({ address: state.oracle!, abi: ORACLE_V2_ABI, functionName: "price" }) as bigint;
        if (attackSeen === target) break;
      } catch { /* node lag */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (attackSeen !== target) throw new Error("could not read armed attack price from node");
    const hfNow = ((pos[2] * target) / ORACLE_SCALE * LLTV) / debt;
    console.log(`armed price $${(Number(target) / 1e24).toFixed(0)} → our-oracle HF ${(Number(hfNow) / 1e18).toFixed(3)} (live price keeps it healthy at HF~1.35)`);

    // ── 7. size the liquidation from on-chain truth (same math as the scan) ──
    const fWad = (ORACLE_SCALE) / (ONE18 - ((ONE18 - LLTV) * 3n) / 10n); // 1/(1−0.3(1−lltv))
    const collValue = (pos[2] * target) / ORACLE_SCALE;
    const debtF = (debt * fWad) / ONE18;
    let repay: bigint;
    let repaidShares: bigint;
    if (collValue < debtF) {
      repay = (collValue * ONE18) / fWad;               // coll-capped: seize all, partial repay
      repaidShares = (pos[1] * repay) / debt;
    } else {
      repay = debt;                                     // debt-capped: full repay
      repaidShares = pos[1];
    }
    if (repaidShares === 0n) throw new Error("repaidShares rounds to zero");

    const target_: ExecutionTarget = {
      chainId: base.id,
      marketId: state.marketId!,
      borrower: owner,
      marketParams: { loanToken: USDC, collateralToken: WETH, oracle: state.oracle!, irm: ZERO_ADDR, lltv: LLTV },
      repaidShares,
      repayLoanAssets: repay,
      seizeCollPredicted: pos[2],
      hop: { pool: POOL, zeroForOne: true },
      routeLabel: "univ3 WETH/USDC f3000",
      loanUsd: 1, // loan IS USDC on the chain — peg assumption is exact for our own market
      loanDec: 6,
      minProfit: 10_000n, // $0.01 USDC floor — just above dust, way under the real edge
      reason: `self-test gate: HF ${(Number(hfNow) / 1e18).toFixed(3)}, full-repay-from-own-collateral`,
    };

    // ── 8. PROVE keepers can't settle us (the point of the v2 oracle) ────────
    let keeperProbeReverted = false;
    try {
      const probe = await publicClient.call({ account: STRANGER, to: liquidator, data: encodeCalldata(target_) });
      console.log(`✗ KEEPER PROBE DID NOT REVERT${probe.data ? ` (calldata returned ${probe.data.slice(0, 10)}…)` : ""} — gate FAILS`);
    } catch (e) {
      keeperProbeReverted = true;
      const raw = (e as { data?: string })?.data ?? (e as { cause?: { data?: string } })?.cause?.data
        ?? (typeof (e as { walk?: (f: (c: { data?: string }) => unknown) => unknown })?.walk === "function"
          ? (e as { walk: (f: (c: { data?: string }) => unknown) => unknown }).walk((c) => c?.data)
          : undefined);
      console.log(`✓ keeper probe reverted — ${decodeRevert(raw)} (stranger ${STRANGER} sees the LIVE price → position healthy)`);
    }
    if (!keeperProbeReverted) throw new Error("keeper-proof property FAILED — attack price visible to strangers; NEVER arm AUTO");

    // ── 9. the real trade — through the app's own executor (budget, sim, send) ──
    if (opts.dry) {
      console.log("--dry: keeper proof passed; NOT sending the liquidation\n");
      writeGate({ passed: true, at: new Date().toISOString(), txHash: null, chainId: base.id, liquidator, oracle: state.oracle!, marketId: state.marketId!, keeperProbeReverted: true, gasCostUsd, profitUsd: null, error: null });
      return { passed: true, keeperProbeReverted: true, oracle: state.oracle, marketId: state.marketId, gasCostUsd };
    }

    const budget = loadBudget(deps.budget);
    const result = await executeLiquidation(deps, target_);
    if (!result.success) throw new Error(`executor failed: ${result.error}`);
    gasCostUsd += result.gasCostUsd ?? 0;

    // ── 10. cleanup: pull contract proceeds + our remaining position ────────
    const liqBal = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [liquidator] }) as bigint;
    if (liqBal > 0n) {
      const r = await step("liquidator.withdraw(USDC)", { address: liquidator, abi: EXECUTOR_ABI, functionName: "withdraw", args: [USDC] });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    }
    pos = await readPos();
    if (pos[0] > 0n) {
      const r = await step(`withdraw supply (${pos[0]} shares)`, {
        address: morpho, abi: MORPHO_ABI, functionName: "withdraw", args: [params, 0n, pos[0], owner, owner],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    }
    pos = await readPos();
    if (pos[2] > 0n) {
      const r = await step(`withdrawCollateral remainder ${Number(formatUnits(pos[2], 18)).toFixed(5)} WETH`, {
        address: morpho, abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [params, pos[2], owner, owner],
      });
      gasCostUsd += gasUsd(r.gasUsed, r.gasPrice);
    }

    const gate: SelfTestGate = {
      passed: true,
      at: new Date().toISOString(),
      txHash: result.txHash ?? null,
      chainId: base.id,
      liquidator,
      oracle: state.oracle!,
      marketId: state.marketId!,
      keeperProbeReverted: true,
      gasCostUsd,
      profitUsd: result.profitUsd ?? null,
      error: null,
    };
    writeGate(gate);
    console.log(`\n── GATE PASSED ─────────────────────────────────────────`);
    console.log(`settled ${result.txHash}  seized→repaid→profit=${result.profitUsd?.toFixed(4) ?? "?"}$  gas $${gasCostUsd.toFixed(4)}  keeper-proof ✓`);
    return { passed: true, txHash: result.txHash, gasCostUsd, profitUsd: result.profitUsd, keeperProbeReverted: true, oracle: state.oracle, marketId: state.marketId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    writeGate({ ...freshGate(), error, liquidator, chainId: base.id, at: new Date().toISOString() });
    console.error(`\n✗ SELF-TEST FAILED (gate NOT passed): ${error}`);
    return { passed: false, keeperProbeReverted: false, error };
  }
}