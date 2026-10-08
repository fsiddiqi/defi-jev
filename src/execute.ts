// Real execution against the deployed MorphoFlashLiquidator (flash-free,
// zero-capital, Morpho Blue only). This replaces the abandoned Balancer
// flash-loan cToken scaffold — the only thing that can ever sign a trade here.
//
// Every trade: (1) gas-budget precheck, (2) live eth_call simulation against
// the deployed contract state (any revert blocks — nothing invented), (3) send
// with a real gas buffer (exact-fit estimates OOG'd in production), (4) decode
// the Liquidated event for measured seized/repaid/profit. minProfit is enforced
// on-chain by the contract (Unprofitable revert).
import {
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type PublicClient,
  type WalletClient,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import type { ExecutionResult } from "./types.js";
import { loadBudget, canSpend, recordSpend, DAY_KEY, type BudgetConfig, type BudgetState } from "./lib/budget.js";

export interface LoopDeps {
  publicClient: PublicClient;
  wallet: WalletClient;
  morpho: Address;
  liquidator: Address;
  owner: Address;
  rpcLabel: string;
  ethPriceUsd: number;
  budget: BudgetConfig;
}

export interface ExecutionTarget {
  chainId: number;
  marketId: Address;
  borrower: Address;
  marketParams: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
  /** shares to repay (position borrowShares for a full repay) */
  repaidShares: bigint;
  /** loan wei this rung repays (ceil) — for minProfit + reporting */
  repayLoanAssets: bigint;
  /** predicted collateral wei to seize (reported, not trusted) */
  seizeCollPredicted?: bigint;
  /** single-hop exit */
  hop: { pool: Address; zeroForOne: boolean };
  routeLabel: string;
  loanUsd: number | null;
  loanDec: number;
  /** minProfit floor in loan wei (contract reverts below it) */
  minProfit: bigint;
  reason: string; // what cleared this to EXECUTE (for the audit trail)
}

export const EXECUTOR_ABI = parseAbi([
  "function executeLiquidation((address,address,address,address,uint256),address,uint256,(address,bool)[],uint256) returns (uint256 seizedCollateral,uint256 repaidAssets,uint256 profit)",
]);

export const LIQUIDATED_EVENT = parseAbiItem(
  "event Liquidated(address indexed borrower, address indexed loanToken, address indexed collateralToken, uint256 seizedCollateral, uint256 repaidAssets, uint256 profit)",
);

export function encodeCalldata(t: ExecutionTarget): Hex {
  return encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "executeLiquidation",
    args: [
      [
        t.marketParams.loanToken,
        t.marketParams.collateralToken,
        t.marketParams.oracle,
        t.marketParams.irm,
        t.marketParams.lltv,
      ],
      t.borrower,
      t.repaidShares,
      [[t.hop.pool, t.hop.zeroForOne]],
      t.minProfit,
    ],
  });
}

export function loanWeiToUsd(wei: bigint, loanDec: number, loanUsd: number | null): number | null {
  if (loanUsd == null) return null;
  return (Number(wei) / 10 ** loanDec) * loanUsd;
}

export async function simulateLiquidation(
  deps: LoopDeps,
  t: ExecutionTarget,
): Promise<{ ok: true; gas: bigint } | { ok: false; error: string }> {
  const data = encodeCalldata(t);
  try {
    const [gas, call] = await Promise.all([
      deps.publicClient.estimateGas({ account: deps.owner, to: deps.liquidator, data, value: 0n }),
      deps.publicClient.call({ account: deps.owner, to: deps.liquidator, data, value: 0n }),
    ]);
    if (!call.data) return { ok: false, error: "eth_call returned no data" };
    return { ok: true, gas };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function executeLiquidation(
  deps: LoopDeps,
  t: ExecutionTarget,
): Promise<ExecutionResult> {
  if (t.chainId !== base.id) {
    return { success: false, error: `chain ${t.chainId} not wired to an executor yet` };
  }
  const account = deps.wallet.account;
  if (!account?.address) {
    return { success: false, error: "no wallet account" };
  }

  const budget = loadBudget(deps.budget);

  // 1. Simulate BEFORE any spending — a revert means no tx.
  const sim = await simulateLiquidation(deps, t);
  if (!sim.ok) {
    return { success: false, error: `simulation reverted: ${sim.error}` };
  }
  const gasLimit = (sim.gas * 150n) / 100n; // real buffer: exact-fit OOG'd twice in prod
  const gasPrice = await deps.publicClient.getGasPrice();
  const gasUsd = (Number(gasLimit) * Number(gasPrice) * deps.ethPriceUsd) / 1e18;
  const budgetCheck = canSpend(budget, deps.budget, gasUsd);
  if (!budgetCheck.ok) {
    recordSpend(deps.budget, budget, { gasUsd, status: "blocked" });
    return { success: false, error: `budget blocked: ${budgetCheck.reason}` };
  }

  // 2. Send.
  let txHash: Hex;
  try {
    txHash = await deps.wallet.sendTransaction({
      chain: base,
      account,
      to: deps.liquidator,
      data: encodeCalldata(t),
      gas: gasLimit,
    });
  } catch (e) {
    recordSpend(deps.budget, budget, { gasUsd: 0, status: "blocked" });
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 3. Wait + measure.
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    const gasPaid = (Number(receipt.gasUsed) * Number(gasPrice) * deps.ethPriceUsd) / 1e18;
    if (receipt.status !== "success") {
      recordSpend(deps.budget, budget, { gasUsd: gasPaid, status: "reverted", txHash });
      return {
        success: false,
        txHash,
        gasUsed: receipt.gasUsed,
        gasCostUsd: gasPaid,
        error: `tx reverted (oracle moved / out-competed)`,
      };
    }

    const log = receipt.logs.find((l) => l.address.toLowerCase() === deps.liquidator.toLowerCase());
    if (!log) {
      recordSpend(deps.budget, budget, { gasUsd: gasPaid, status: "success", txHash });
      return { success: false, txHash, gasUsed: receipt.gasUsed, gasCostUsd: gasPaid, error: "no Liquidated log" };
    }
    const decoded = decodeEventLog({
      abi: [LIQUIDATED_EVENT],
      data: log.data,
      topics: log.topics as [Hex, Hex, Hex, Hex],
      strict: true,
    });
    const args = decoded.args as unknown as { seizedCollateral: bigint; repaidAssets: bigint; profit: bigint };

    const profitUsd = loanWeiToUsd(args.profit, t.loanDec, t.loanUsd);
    // seized collateral is COLLATERAL wei, not loan wei — converting it to USD
    // would need the collateral price, so we report raw wei for the audit trail
    // instead of inventing a USD figure.
    recordSpend(deps.budget, budget, { gasUsd: gasPaid, status: "success", txHash, profitUsd: profitUsd ?? undefined });

    return {
      success: true,
      txHash,
      gasUsed: receipt.gasUsed,
      gasCostUsd: gasPaid,
      seizedCollateralRaw: args.seizedCollateral,
      profitUsd: profitUsd ?? undefined,
    };
  } catch (e) {
    recordSpend(deps.budget, budget, { gasUsd: 0, status: "blocked" });
    return { success: false, txHash, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── re-exports for main/UI ────────────────────────────────────────────────────
export { loadBudget, DAY_KEY };
export type { BudgetState };