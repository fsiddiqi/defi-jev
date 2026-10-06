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
// once. Gross profit = seized * (1 - 1/f), and is positive for EVERY
// liquidatable position (f > 1) — deep-underwater positions are not "graveyard",
// they are liquidatable at the same edge (the remaining borrow becomes bad debt).
//
// Ionic is a Compound-v2 style fork: a per-liquidation close factor (`repay` is
// capped at closeFactor * borrow) and a liquidation bonus on the repaid value.

export const SLIPPAGE_BPS = 50; // assumed round-trip swap cost, seized collateral -> borrow asset
export const ETH_USD_ASSUMED = 3000; // rough USD conversion for gas

// Morpho Blue (from ConstantsLib.sol in morpho-org/morpho-blue)
export const MORPHO_LIQUIDATION_CURSOR = 0.3;
export const MORPHO_MAX_INCENTIVE = 0.15;

// Ionic (compound-v2 defaults; env-tunable per deployed markets)
export const IONIC_CLOSE_FACTOR = Math.min(1, Math.max(0, Number(process.env.IONIC_CLOSE_FACTOR ?? "0.5")));
export const IONIC_INCENTIVE = Math.max(0, Number(process.env.IONIC_INCENTIVE ?? "0.08"));

export function gasCostUsd(candidate: LiquidationCandidate): number {
  return candidate.estimatedExecutionGas * candidate.gasPriceGwei * 1e-9 * ETH_USD_ASSUMED;
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

// Net profit after the liquidation edge, gas, and the round-trip swap cost.
// Can legitimately be near zero or small; never the whole seized collateral.
export function projectedProfitUsd(candidate: LiquidationCandidate): number {
  const seized = expectedSeizeUsd(candidate);
  const edgeOfSeize = candidate.protocol === "ionic"
    ? IONIC_INCENTIVE / (1 + IONIC_INCENTIVE)
    : morphoEdgeOfSeize(candidate.liquidationThreshold);
  const gross = seized * edgeOfSeize;
  return gross - gasCostUsd(candidate) - seized * (SLIPPAGE_BPS / 10_000);
}