// Candidate → execution target. Nothing here is estimated or guessed: the
// numbers the executor will send come from a FRESH on-chain read of the exact
// position being liquidated (no scan-subgraph or Jev-cache state) plus a real
// exit quote at the rung being taken. Any gate failure returns `ok:false` with
// the honest reason — this is the last line of defense before a real tx.
import type { Address, PublicClient } from "viem";
import type { LiquidationCandidate, ExecutionConfig } from "../types.js";
import { loadMarketTruth, seizeAndRepay } from "./morpho.js";
import { pickBestExit } from "./routes.js";
import type { ExecutionTarget } from "../execute.js";

export type BuildResult =
  | { ok: true; target: ExecutionTarget }
  | { ok: false; reason: string };

export async function buildExecutionTarget(
  client: PublicClient,
  rpcLabel: string,
  morpho: Address,
  candidate: LiquidationCandidate,
  ethPriceUsd: number,
  cfg: ExecutionConfig,
): Promise<BuildResult> {
  if (candidate.watch) return { ok: false, reason: "at-risk watch row (HF > 1.0)" };
  if (!candidate.marketId) return { ok: false, reason: "no marketId from scan" };
  if (candidate.chainId !== 8453) return { ok: false, reason: `chain ${candidate.chainId} not executable yet` };

  // 1. Fresh on-chain truth (bypass the scan-time cache).
  let truth;
  try {
    truth = await loadMarketTruth(client, rpcLabel, morpho, candidate.marketId, candidate.borrower, {
      noCache: true,
    });
  } catch (e) {
    return { ok: false, reason: `on-chain read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const hf = Number(truth.healthFactorWad) / 1e18;
  if (truth.healthFactorWad >= 10n ** 18n) {
    return { ok: false, reason: `not liquidatable on-chain (HF ${hf.toFixed(3)} >= 1.0)` };
  }
  const { debtAssets, collValueLoanWei, collateral } = truth;
  if (debtAssets === 0n || collValueLoanWei === 0n) {
    return { ok: false, reason: "zero debt or zero collateral on-chain" };
  }

  // 2. Whole-position economics (same math as target-scan).
  const { seizeLoan, repayLoan, seizeColl } = seizeAndRepay(collateral, collValueLoanWei, debtAssets, truth.params.lltv);
  if (seizeLoan === 0n || repayLoan === 0n || seizeColl === 0n) {
    return { ok: false, reason: "seize/repay rounds to zero" };
  }

  // 3. Honest loan→USD (peg assumption for known stables only is implicit via
  //    loanUsd: derived from the scan's USD files, never defaulted to 1.0).
  const debtLoanUnits = Number(debtAssets) / 10 ** truth.loanDec;
  const loanUsd = debtLoanUnits > 0 ? candidate.borrowBalanceUsd / debtLoanUnits : null;
  if (loanUsd == null || loanUsd <= 0) {
    return { ok: false, reason: "loan price unknowable (no honest USD translation)" };
  }

  // 4. Real exit quote — ladder down from full seize, require proceeds ≥ repay.
  const best = await pickBestExit(
    client,
    candidate.chainId,
    truth.params.collateralToken,
    truth.params.loanToken,
    seizeColl,
    repayLoan,
  );
  if (!best) {
    return { ok: false, reason: "no single-hop exit clears the repay (proceeds < repay)" };
  }

  // 5. minProfit floor in loan wei from the USD forecast floor.
  const minProfitUsd = cfg.minProfitForecastUsd > 0 ? cfg.minProfitForecastUsd : 1;
  const minProfitWei =
    BigInt(Math.ceil((minProfitUsd * 10 ** truth.loanDec) / loanUsd)) + 1n;
  const bestRepay = (repayLoan * BigInt(Math.round(best.sizeFrac * 1e6))) / 1_000_000n;
  const quotedProfit = best.proceeds - bestRepay;
  if (quotedProfit < minProfitWei) {
    return {
      ok: false,
      reason: `quoted profit ${usd(quotedProfit, truth.loanDec, loanUsd)} below minProfit floor $${minProfitUsd.toFixed(2)}`,
    };
  }

  const sharesFrac = (truth.borrowShares * BigInt(Math.round(best.sizeFrac * 1e6))) / 1_000_000n || 1n;
  const repaidShares = sharesFrac > truth.borrowShares ? truth.borrowShares : sharesFrac;
  if (repaidShares === 0n) return { ok: false, reason: "repaid shares round to zero" };

  return {
    ok: true,
    target: {
      chainId: candidate.chainId,
      marketId: candidate.marketId,
      borrower: candidate.borrower,
      marketParams: truth.params,
      repaidShares,
      repayLoanAssets: bestRepay,
      seizeCollPredicted: best.amountIn,
      hop: { pool: best.route.pool, zeroForOne: best.route.zeroForOne },
      routeLabel: best.route.label,
      loanUsd,
      loanDec: truth.loanDec,
      minProfit: minProfitWei,
      reason: `on-chain HF ${hf.toFixed(4)} · ${best.route.label} @${Math.round(best.sizeFrac * 100)}% · quoted profit ${usd(quotedProfit, truth.loanDec, loanUsd)}`,
    },
  };
}

function usd(wei: bigint, dec: number, loanUsd: number): string {
  return `$${(((Number(wei) / 10 ** dec) * loanUsd)).toFixed(2)}`;
}