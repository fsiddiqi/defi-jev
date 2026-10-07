import type { ExecutionConfig, LiquidationCandidate } from "../types.js";

// Pure, deterministic gates. Extracted from src/main.ts so they can be unit
// tested: no console noise, explicit configuration, no network/API access.

export interface GateVerdict {
  pass: boolean;
  reason: string;
}

export const DEFAULT_MAX_HF_MISMATCH_PCT = 0.30;

// Health factor implied by the USD balances, as the protocol defines it:
//   HF = collateralUsd * lltv / borrowUsd
// Returns null when there is no usable ratio to compare.
export function hfFromBalances(
  candidate: Pick<
    LiquidationCandidate,
    "collateralBalanceUsd" | "borrowBalanceUsd" | "liquidationThreshold"
  >,
): number | null {
  const { collateralBalanceUsd: coll, borrowBalanceUsd: borrow, liquidationThreshold: lltv } = candidate;
  if (coll <= 0 || borrow <= 0) return null;
  return (lltv * coll) / borrow;
}

// Compares the indexer-reported health factor against the HF implied by the
// USD balances. Blocks when the two sources contradict each other on whether
// the position is liquidatable, or when the magnitude gap exceeds the tolerance.
// Pure arithmetic; this must stay ahead of Jev because the classifier proved
// unreliable at applying this rule to raw pairs of numbers.
export function dataIntegrityGate(
  candidate: LiquidationCandidate,
  maxMismatchPct: number = Number(
    process.env.MAX_HF_MISMATCH_PCT ?? String(DEFAULT_MAX_HF_MISMATCH_PCT),
  ),
): GateVerdict {
  const hfFromUsd = hfFromBalances(candidate);
  const hf = candidate.healthFactor;
  const mismatchPct = hfFromUsd !== null && hf > 0 ? Math.abs(hfFromUsd - hf) / hf : null;
  const directionAgrees =
    hfFromUsd !== null && hf > 0 ? (hfFromUsd > 1) === (hf > 1) : true;

  if (hfFromUsd !== null && hf > 0 && !directionAgrees) {
    return {
      pass: false,
      reason: `data integrity: HF direction conflict (indexer ${hf.toFixed(3)} vs balances ${hfFromUsd.toFixed(3)})`,
    };
  }
  if (mismatchPct !== null && mismatchPct > maxMismatchPct) {
    return {
      pass: false,
      reason: `data integrity: HF mismatch ${(mismatchPct * 100).toFixed(1)}% > ${(maxMismatchPct * 100).toFixed(0)}%`,
    };
  }
  return { pass: true, reason: "" };
}

// Cheap mechanical gates run before Jev. Returns the blocking reason when the
// candidate should not reach the classifier.
export function preJevGates(
  candidate: LiquidationCandidate,
  config: ExecutionConfig,
): GateVerdict {
  if (candidate.oracleFreshnessSec > 60) {
    return { pass: false, reason: `Oracle stale (${candidate.oracleFreshnessSec}s)` };
  }
  if (candidate.gasPriceGwei > 100) {
    return { pass: false, reason: `Gas too high (${candidate.gasPriceGwei} gwei)` };
  }
  if (candidate.expectedSeizeUsd < config.minSeizeUsd) {
    return {
      pass: false,
      reason: `Seize too small ($${candidate.expectedSeizeUsd.toFixed(2)})`,
    };
  }
  // HF ≈ 1 ⟺ LTV ≈ threshold: too close to the liquidation line to bother racing
  if (candidate.healthFactor > 0.98) {
    return {
      pass: false,
      reason: `LTV spread too tight (HF ${candidate.healthFactor.toFixed(3)})`,
    };
  }
  return { pass: true, reason: "" };
}