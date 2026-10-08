import type { LiquidationCandidate } from "../types.js";
import { projectedProfitUsd } from "../profit.js";

// The "would-actually-play" slice of the at-risk watchlist. A warm Jev verdict
// on a whale-size row (e.g. $130M USDe) is honest economics but not something a
// small bot can fund or exit. Playable = a position a solo liquidator could
// realistically act on IF it crosses into liquidation:
//   - sized so the seize is fundable (cap),
//   - warm profit above the configured floor.
// Oracle age: Morpho oracle WRAPPERS usually don't expose latestRoundData, so a
// null age just means "age not exposed by this contract" — the price IS re-read
// from the on-chain oracle each scan (300s TTL), so unknown age is acceptable.
// Only a VERIFIED stale age (age > max) is excluded.
// This is a display/queue classification, not a gate: playable rows still never
// execute (they are watch rows, HF > 1.0).
export interface WatchPlayableConfig {
  capUsd: number;
  minProfitUsd: number;
  maxOracleAgeSec: number;
}

export function isWatchPlayable(
  candidate: LiquidationCandidate,
  cfg: WatchPlayableConfig,
  ethPriceUsd: number,
): boolean {
  if (!candidate.watch) return false;
  if (candidate.expectedSeizeUsd > cfg.capUsd) return false;
  if (candidate.oracleAgeSec !== null && candidate.oracleAgeSec > cfg.maxOracleAgeSec) return false;
  if ((projectedProfitUsd(candidate, ethPriceUsd) ?? 0) < cfg.minProfitUsd) return false;
  return true;
}