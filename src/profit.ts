import type { LiquidationCandidate } from "./types.js";

// Single source of truth for projected economics. Used by the post-Jev profit
// gate, the UI feed, the paper log, AND the state we hand to Jev — so Jev's
// filtering decisions are made against exactly the numbers we gate on.
//
// Morpho Blue economics are taken from the deployment of Morpho.sol -> liquidate():
//   incentiveFactor f = min(MAX_LIQUIDATION_INCENTIVE_FACTOR,
//                           1 / (1 - LIQUIDATION_CURSOR * (1 - lltv)))
//   with LIQUIDATION_CURSOR = 0.3 and MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15.
// The liquidator repays money and receives collateral whose USD (oracle) value
// is repaid * f. There is NO close factor: the whole position can be taken at
// once. The oracle is what the protocol prices liquidations at — it is NOT
// necessarily what you can sell the collateral for.
//
// Realized profit = sale proceeds − repayment − costs:
//   sale proceeds = seized (oracle USD) * (dexPrice / oraclePrice)
//   repayment     = seized / f
// A position is only profitably realizable when a real exit venue exists
// (verified DEX pool for listed/long-tail collateral; deep real markets for
// stable/bluechip/lrt). priceSource: "none" => profit is honestly $0. No
// invented sale prices, ever.

export const SLIPPAGE_BPS = 50; // assumed base round-trip swap cost, seized collateral -> borrow asset
export const ETH_USD_ASSUMED = 3000; // fallback ONLY when no live ETH price is passed in
// Max seized USD a single exit can clear: fraction of the pool's one-sided depth.
// Above it the sale would wreck the book — profit is treated as $0, not guessed.
export const EXIT_DEPTH_FRACTION = Number(process.env.EXIT_DEPTH_FRACTION ?? "0.05");
export const MAX_EXTRA_IMPACT_BPS = 1000; // cap on depth-scaled slippage (10%)

// Morpho Blue (from ConstantsLib.sol in morpho-org/morpho-blue)
export const MORPHO_LIQUIDATION_CURSOR = 0.3;
export const MORPHO_MAX_INCENTIVE = 0.15;

// Ionic (compound-v2 defaults; env-tunable per deployed markets)
export const IONIC_CLOSE_FACTOR = Math.min(1, Math.max(0, Number(process.env.IONIC_CLOSE_FACTOR ?? "0.5")));
export const IONIC_INCENTIVE = Math.max(0, Number(process.env.IONIC_INCENTIVE ?? "0.08"));

// Tiers with deep, real markets: the oracle price IS the sale price.
const EXIT_VERIFIED_TIERS = new Set(["stable", "bluechip", "lrt"]);

export function gasCostUsd(candidate: LiquidationCandidate, ethPriceUsd: number = ETH_USD_ASSUMED): number {
  return candidate.estimatedExecutionGas * candidate.gasPriceGwei * 1e-9 * ethPriceUsd;
}

// The on-chain liquidation incentive factor f (>= 1). The liquidator receives
// collateral worth `repaid * f` for every dollar of debt repaid.
export function morphoIncentiveFactor(lltv: number): number {
  const l = Math.min(Math.max(lltv, 0.001), 0.999);
  const f = 1 / (1 - MORPHO_LIQUIDATION_CURSOR * (1 - l));
  return Math.min(1 + MORPHO_MAX_INCENTIVE, f);
}

// Profit as a fraction of the seized collateral value: 1 - 1/f.
// LLTV 0.86 -> 4.20%, 0.90 -> 3.00%, 0.915 -> 2.55%, <=0.565 -> 13.04% (cap).
export function morphoEdgeOfSeize(lltv: number): number {
  return 1 - 1 / morphoIncentiveFactor(lltv);
}

// Collateral value the liquidator can seize in one liquidate() call.
// Morpho: whole position, seizedUSD = min(collateral, borrow * f)
// (you can never seize more than C, and never repay more than the debt B).
export function morphoSeizedUsd(
  borrowUsd: number,
  collateralUsd: number,
  lltv: number,
): number {
  if (borrowUsd <= 0 || collateralUsd <= 0) return 0;
  return Math.min(collateralUsd, borrowUsd * morphoIncentiveFactor(lltv));
}

// Compound-v2 style: repay = min(closeFactor * borrow, collateral / (1 + bonus));
// receive collateral worth repay * (1 + bonus) (so seized <= collateral).
export function ionicSeizedUsd(
  borrowUsd: number,
  collateralUsd: number,
  closeFactor: number = IONIC_CLOSE_FACTOR,
  incentive: number = IONIC_INCENTIVE,
): number {
  if (borrowUsd <= 0 || collateralUsd <= 0) return 0;
  const repay = Math.min(closeFactor * borrowUsd, collateralUsd / (1 + incentive));
  return repay * (1 + incentive);
}

// Gross collateral value the candidate's liquidation would actually capture.
export function expectedSeizeUsd(candidate: LiquidationCandidate): number {
  const { protocol, borrowBalanceUsd, collateralBalanceUsd, liquidationThreshold } = candidate;
  if (protocol === "ionic") return ionicSeizedUsd(borrowBalanceUsd, collateralBalanceUsd);
  return morphoSeizedUsd(borrowBalanceUsd, collateralBalanceUsd, liquidationThreshold);
}

// ── Realizability ("no fictions") ────────────────────────────────────────────

// True when the seized collateral has a verified way to be sold:
//  - stable/bluechip/lrt: deep real markets, oracle price is the sale price;
//  - listed/long-tail: ONLY when an actual on-chain pool was found and priced.
export function isExitVerified(candidate: LiquidationCandidate): boolean {
  if (EXIT_VERIFIED_TIERS.has(candidate.collateralTier)) return true;
  return (
    candidate.dexPriceUsd !== null &&
    candidate.exitLiquidityUsd !== null &&
    candidate.exitLiquidityUsd > 0
  );
}

// Max USD of seized collateral that can be exited in one shot without wrecking
// the pool book (EXIT_DEPTH_FRACTION of the one-sided depth).
export function exitCapUsd(exitLiquidityUsd: number | null): number {
  if (!exitLiquidityUsd || exitLiquidityUsd <= 0) return 0;
  return exitLiquidityUsd * EXIT_DEPTH_FRACTION;
}

// Effective sale-price ratio vs the oracle: dexPrice/oraclePrice (1.0 = sell at
// the same price the protocol liquidated at). Only meaningful when both are
// known; otherwise 1 (oracle assumed realizable — true for deep-market tiers).
export function salePriceRatio(candidate: LiquidationCandidate): number {
  if (
    candidate.dexPriceUsd !== null &&
    candidate.oraclePriceUsd !== null &&
    candidate.oraclePriceUsd > 0 &&
    candidate.dexPriceUsd > 0
  ) {
    return candidate.dexPriceUsd / candidate.oraclePriceUsd;
  }
  return 1;
}

// Depth-scaled slippage: flat base + extra proportional to how much of the
// one-sided book the sale consumes (1% of depth ~= 100bps price impact on a
// constant-product pool). Capped at MAX_EXTRA_IMPACT_BPS. Transparent, not a
// guess: it uses the pool's real on-chain depth.
export function depthImpactBps(seizeUsd: number, exitLiquidityUsd: number): number {
  if (exitLiquidityUsd <= 0) return SLIPPAGE_BPS;
  const extra = (seizeUsd / exitLiquidityUsd) * 100;
  return Math.min(MAX_EXTRA_IMPACT_BPS, SLIPPAGE_BPS + extra);
}

// Net profit after the liquidation edge, gas, and the round-trip swap cost.
// Can legitimately be near zero or small; never the whole seized collateral.
// Moves to $0 — honestly — whenever the collateral has no real exit venue
// (priceSource "none") or the seized size cannot clear the pool book.
export function projectedProfitUsd(candidate: LiquidationCandidate, ethPriceUsd: number = ETH_USD_ASSUMED): number {
  const seized = expectedSeizeUsd(candidate);
  if (seized <= 0) return 0;
  const gas = gasCostUsd(candidate, ethPriceUsd);

  if (candidate.protocol === "ionic") {
    const edge = IONIC_INCENTIVE / (1 + IONIC_INCENTIVE);
    return seized * edge - gas - seized * (SLIPPAGE_BPS / 10_000);
  }

  // Morpho Blue
  if (!isExitVerified(candidate)) return 0; // no sale venue -> no profit, no fiction
  // Depth cap only bites when a real pool was found (exitLiquidityUsd set):
  // stable/bluechip/lrt have no pool-derived cap — the oracle IS the exit.
  if (candidate.exitLiquidityUsd !== null && seized > exitCapUsd(candidate.exitLiquidityUsd)) return 0;
  const ratio = salePriceRatio(candidate);
  const impactBps = candidate.exitLiquidityUsd ? depthImpactBps(seized, candidate.exitLiquidityUsd) : SLIPPAGE_BPS;
  const f = morphoIncentiveFactor(candidate.liquidationThreshold);
  const grossEdge = seized * (ratio - 1 / f);
  return grossEdge - gas - seized * (impactBps / 10_000);
}