import type { ExecutionConfig, LiquidationCandidate } from "../types.js";
import { exitCapUsd, isExitVerified, salePriceRatio } from "../profit.js";

// Pure, deterministic gates. Extracted from src/main.ts so they can be unit
// tested: no console noise, explicit configuration, no network/API access.

export interface GateVerdict {
  pass: boolean;
  reason: string;
}

// Seized collateral selling more than this fraction BELOW the liquidation
// oracle means the "profit" is stale-oracle fiction (or a trap token). 0.15
// never blocks a genuinely profitable Morpho trade: with incentive factor
// f <= 1.15, profit needs ratio > 1/f >= 0.8696, and 1 - 0.15 = 0.85.
export const DEFAULT_MAX_ORACLE_DISCOUNT_PCT = 0.15;

/**
 * Realizability — can the seized collateral actually be SOLD for what the
 * oracle says it is worth? These are the arithmetic checks Jev used to do
 * from its prompt (rule #4 REALIZABILITY); they are deterministic facts the
 * code already computes, so they belong in a gate, not a classifier.
 * Single source of truth: profit.ts (isExitVerified/exitCapUsd/salePriceRatio).
 */
export function realizabilityGate(
  candidate: LiquidationCandidate,
  maxOracleDiscountPct: number = Number(
    process.env.MAX_ORACLE_DISCOUNT_PCT ?? String(DEFAULT_MAX_ORACLE_DISCOUNT_PCT),
  ),
): GateVerdict {
  // 1. No verifiable exit => projectedProfitUsd is $0 by construction (profit.ts).
  if (!isExitVerified(candidate)) {
    return {
      pass: false,
      reason: `exit not verifiable (tier=${candidate.collateralTier}, priceSource=${candidate.priceSource}, venue=${candidate.saleVenue ?? "none"}) — profit is $0 by construction`,
    };
  }
  // 2. Depth cap: one exit may not consume more than EXIT_DEPTH_FRACTION of
  //    the one-sided book (the live RSS case: $1.4M seize against a $1.65 pool).
  if (
    candidate.exitLiquidityUsd !== null &&
    candidate.expectedSeizeUsd > exitCapUsd(candidate.exitLiquidityUsd)
  ) {
    return {
      pass: false,
      reason: `exit can't clear seize: cap $${exitCapUsd(candidate.exitLiquidityUsd).toFixed(2)} (5% of depth $${candidate.exitLiquidityUsd.toFixed(2)}) < seize $${candidate.expectedSeizeUsd.toFixed(0)}`,
    };
  }
  // 3. Sale-price distortion: selling below the liquidation oracle eats the
  //    Morpho bonus; beyond the tolerance it is fiction or a honeypot.
  if (candidate.dexPriceUsd !== null) {
    const ratio = salePriceRatio(candidate);
    if (ratio < 1 - maxOracleDiscountPct) {
      return {
        pass: false,
        reason: `collateral sells ${((1 - ratio) * 100).toFixed(1)}% below liquidation oracle (dex/oracle=${ratio.toExponential(2)}) — profit is stale-oracle fiction`,
      };
    }
  }
  return { pass: true, reason: "" };
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
  // Realizability last: venue/depth/price-distortion arithmetic (see above).
  const realizable = realizabilityGate(candidate);
  if (!realizable.pass) return realizable;
  return { pass: true, reason: "" };
}