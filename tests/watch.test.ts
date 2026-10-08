import { describe, expect, it } from "vitest";
import { isWatchPlayable, type WatchPlayableConfig } from "../src/lib/watch.js";
import type { LiquidationCandidate } from "../src/types.js";

function cand(over: Partial<LiquidationCandidate>): LiquidationCandidate {
  return {
    protocol: "morpho-blue",
    borrower: "0x0000000000000000000000000000000000000000",
    collateralAsset: "cbETH",
    collateralTier: "bluechip",
    borrowAsset: "USDC",
    currentLtv: 0.85,
    liquidationThreshold: 0.915,
    healthFactor: 1.09,
    collateralBalanceUsd: 170_000,
    borrowBalanceUsd: 150_000,
    seizePct: 0.023,
    expectedSeizeUsd: 150_000,
    oracleFreshnessSec: 5,
    gasPriceGwei: 0.02,
    estimatedExecutionGas: 900_000,
    recentPriceMovePct30m: 0,
    cascadeScore: 0,
    competitionLast10Blocks: 0,
    ageBlocks: 999,
    oraclePriceUsd: 4000,
    oracleAgeSec: 30,
    dexPriceUsd: null,
    exitLiquidityUsd: null,
    priceSource: "oracle",
    saleVenue: null,
    watch: true,
    ...over,
  };
}

const CFG: WatchPlayableConfig = { capUsd: 250_000, minProfitUsd: 500, maxOracleAgeSec: 300 };

describe("isWatchPlayable - the honest shortlist slice", () => {
  it("flags a size-appropriate, profitable, fresh-oracle watch row", () => {
    expect(isWatchPlayable(cand({}), CFG, 3000)).toBe(true);
  });
  it("never flags a LIVE (liquidatable) candidate - playable is watch-only", () => {
    expect(isWatchPlayable(cand({ watch: false, healthFactor: 0.94 }), CFG, 3000)).toBe(false);
  });
  it("excludes whale-size rows a solo bot cannot fund", () => {
    expect(isWatchPlayable(cand({ collateralBalanceUsd: 140_000_000, borrowBalanceUsd: 130_000_000, expectedSeizeUsd: 130_000_000 }), CFG, 3000)).toBe(false);
  });
  it("accepts rows whose oracle contract does not expose age (null) - price is re-read on-chain each scan", () => {
    expect(isWatchPlayable(cand({ oracleAgeSec: null }), CFG, 3000)).toBe(true);
  });
  it("excludes rows with a stale oracle", () => {
    expect(isWatchPlayable(cand({ oracleAgeSec: 3600 }), CFG, 3000)).toBe(false);
  });
  it("excludes rows below the profit floor (incl. no-exit rows where profit is $0)", () => {
    expect(isWatchPlayable(cand({ collateralTier: "long-tail", priceSource: "none" }), CFG, 3000)).toBe(false);
    expect(isWatchPlayable(cand({ collateralTier: "listed", priceSource: "dex", dexPriceUsd: 0.5, oraclePriceUsd: 1.0, expectedSeizeUsd: 10_000 }), CFG, 3000)).toBe(false);
  });
  it("applies the floor to the real warm profit (balances-derived seize)", () => {
    // Profit derives from balances, not the expectedSeizeUsd field. Pinned to
    // profit.ts: borrow $10K => seize ≈ $10,262, warm profit ≈ $210 (< $500);
    // borrow $100K => seize ≈ $102,617, profit ≈ $2,104 (≥ $500, ≤ $250K cap).
    expect(isWatchPlayable(cand({ collateralBalanceUsd: 12_000, borrowBalanceUsd: 10_000 }), CFG, 3000)).toBe(false);
    expect(isWatchPlayable(cand({ collateralBalanceUsd: 110_000, borrowBalanceUsd: 100_000 }), CFG, 3000)).toBe(true);
  });
});