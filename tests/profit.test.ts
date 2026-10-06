import { describe, expect, it } from "vitest";
import {
  depthImpactBps,
  ETH_USD_ASSUMED,
  exitCapUsd,
  gasCostUsd,
  IONIC_INCENTIVE,
  ionicSeizedUsd,
  morphoEdgeOfSeize,
  morphoIncentiveFactor,
  morphoSeizedUsd,
  projectedProfitUsd,
  salePriceRatio,
  SLIPPAGE_BPS,
} from "../src/profit.js";
import type { LiquidationCandidate } from "../src/types.js";

/** Candidate fixture. projectedProfitUsd/expectedSeizeUsd now DERIVE everything
 *  from balances + liquidationThreshold + price facts, so fixture values are
 *  informational only (what the pipeline would have computed). */
function cand(over: Partial<LiquidationCandidate>): LiquidationCandidate {
  return {
    protocol: "morpho-blue",
    borrower: "0x0000000000000000000000000000000000000000",
    collateralAsset: "RSS",
    collateralTier: "long-tail",
    borrowAsset: "USDC",
    currentLtv: 1.73,
    liquidationThreshold: 0.9,
    healthFactor: 0.4447,
    collateralBalanceUsd: 1_399_976.15, // RSS 0xbF4F29 (oracle-priced)
    borrowBalanceUsd: 2_424_214.03,
    seizePct: 0.03,
    expectedSeizeUsd: 1_399_976.15,
    oracleFreshnessSec: 5,
    gasPriceGwei: 0.02,
    estimatedExecutionGas: 900_000,
    recentPriceMovePct30m: 0,
    cascadeScore: 0,
    competitionLast10Blocks: 0,
    ageBlocks: 999,
    oraclePriceUsd: 1.0,        // RSS oracle nominal peg
    oracleAgeSec: 30,
    dexPriceUsd: null,
    exitLiquidityUsd: null,
    priceSource: "none",        // default: no verifiable exit venue
    saleVenue: null,
    watch: false,
    ...over,
  };
}

const RSS = cand({}); // 0xbF4F29, lltv 0.90 — long-tail, no pool
const USR_BIG = cand({
  collateralAsset: "USR",
  collateralTier: "listed",
  liquidationThreshold: 0.915,
  collateralBalanceUsd: 773_674.44, // 0xA85f4F (oracle-priced)
  borrowBalanceUsd: 20_496_279.15,
  oraclePriceUsd: 1.0000492,
});

describe("gasCostUsd", () => {
  it("defaults to $3000/ETH", () => {
    expect(gasCostUsd(cand({ estimatedExecutionGas: 900_000, gasPriceGwei: 0.02 }))).toBeCloseTo(0.054, 6);
    expect(ETH_USD_ASSUMED).toBe(3000);
  });
  it("uses the LIVE ETH price when passed (the number the UI already shows)", () => {
    expect(gasCostUsd(cand({ estimatedExecutionGas: 900_000, gasPriceGwei: 0.02 }), 2687.55))
      .toBeCloseTo(900_000 * 0.02 * 1e-9 * 2687.55, 6);
  });
});

describe("Morpho liquidation incentive (from ConstantsLib: cursor 0.3, cap 1.15)", () => {
  it("f = 1 / (1 - 0.3*(1-lltv))", () => {
    expect(morphoIncentiveFactor(0.915)).toBeCloseTo(1.026167, 5);
    expect(morphoIncentiveFactor(0.86)).toBeCloseTo(1.043841, 5);
    expect(morphoIncentiveFactor(0.9)).toBeCloseTo(1.030928, 5);
  });
  it("caps at 15% bonus on low-LLTV markets", () => {
    expect(morphoIncentiveFactor(0.5)).toBe(1.15);
    expect(morphoIncentiveFactor(0.565)).toBe(1.15);
  });
  it("the edge fraction is 1 - 1/f (positive for every liquidatable market)", () => {
    expect(morphoEdgeOfSeize(0.9)).toBeCloseTo(0.03, 9); // exactly 3%: 1/f = 0.97
    expect(morphoEdgeOfSeize(0.915)).toBeCloseTo(0.0255, 9);
    expect(morphoEdgeOfSeize(0.86)).toBeCloseTo(0.042, 5);
    expect(morphoEdgeOfSeize(0.7)).toBeGreaterThan(0.08);
  });
});

describe("morphoSeizedUsd - whole position, no close factor", () => {
  it("RSS: collateral-bound, seized = all posted collateral", () => {
    // min(C, B*f) = min(1,399,976, 2,424,214*1.0309) -> C
    expect(morphoSeizedUsd(2_424_214.03, 1_399_976.15, 0.9)).toBeCloseTo(1_399_976.15, 0);
  });
  it("USR 0xA85f4F: collateral-bound (deeply underwater, but seizable at once)", () => {
    expect(morphoSeizedUsd(20_496_279.15, 773_674.44, 0.915)).toBeCloseTo(773_674.44, 0);
  });
  it("near-threshold: borrow-bound, seized = borrow * f (can't repay more than the debt)", () => {
    // B=443.73, C=498.79, lltv 0.86 -> B*f = 463.18 < 498.79
    expect(morphoSeizedUsd(443.73, 498.79, 0.86)).toBeCloseTo(463.18, 1);
    expect(morphoSeizedUsd(100, 105, 0.9)).toBeCloseTo(103.093, 2);
  });
  it("zero-input guard", () => {
    expect(morphoSeizedUsd(0, 500, 0.9)).toBe(0);
    expect(morphoSeizedUsd(500, 0, 0.9)).toBe(0);
  });
});

// ── Realizability: "no fictions, only facts" ─────────────────────────────────

describe("exit venue gating (real sale prices, never invented)", () => {
  it("stable/bluechip/lrt: oracle price IS the exit price — profit is the on-chain edge", () => {
    // 2.55% edge on a $10K seize, 50bps slip, gas ~$0.05
    const c = cand({
      collateralAsset: "USDC", collateralTier: "stable",
      liquidationThreshold: 0.915, borrowBalanceUsd: 5_000_000,
      collateralBalanceUsd: 10_000, expectedSeizeUsd: 10_000,
      oraclePriceUsd: 1.0, priceSource: "oracle",
    });
    expect(projectedProfitUsd(c)).toBeCloseTo(10_000 * 0.0255 - 0.054 - 50, 1);
  });

  it("RSS (long-tail, NO pool): profit is honestly $0 — no sale venue, no fiction", () => {
    expect(projectedProfitUsd(RSS)).toBe(0);
  });
  it("USR $774K (listed, NO pool found): profit is honestly $0", () => {
    expect(projectedProfitUsd(USR_BIG)).toBe(0);
  });

  it("a pool exists but seized size exceeds exitCapUsd (5% of depth): $0 — cannot clear the book", () => {
    // $2M one-sided depth -> cap $100K; RSS seize is $1.4M
    const withPool = cand({
      dexPriceUsd: 0.97, exitLiquidityUsd: 2_000_000, priceSource: "dex",
      saleVenue: "aerodrome-v2 RSS/USDC (volatile)",
    });
    expect(exitCapUsd(withPool.exitLiquidityUsd)).toBe(100_000);
    expect(projectedProfitUsd(withPool)).toBe(0);
  });

  it("sale-priced profit: seized * (dex/oracle - 1/f) - gas - depth impact", () => {
    // USR mid-size: $10K seize, $1M depth (cap $50K), sell at 0.9998 vs oracle
    // 1.0000492 (ratio 0.99975), lltv 0.915 -> 1/f = 0.9745.
    // gross = 10,000 * 0.0252508 = 252.51; impact = 50 + (10K/1M)*100 = 51bps.
    const c = cand({
      collateralAsset: "USR", collateralTier: "listed",
      liquidationThreshold: 0.915, oraclePriceUsd: 1.0000492,
      dexPriceUsd: 0.9998, exitLiquidityUsd: 1_000_000, priceSource: "dex",
      saleVenue: "aerodrome-v2 USR/USDC (stable)",
      borrowBalanceUsd: 500_000, collateralBalanceUsd: 10_000, expectedSeizeUsd: 10_000,
    });
    expect(salePriceRatio(c)).toBeCloseTo(0.9998 / 1.0000492, 6);
    expect(depthImpactBps(10_000, 1_000_000)).toBeCloseTo(51, 9);
    expect(projectedProfitUsd(c)).toBeCloseTo(10_000 * (0.9998 / 1.0000492 - 0.9745) - 0.054 - 51, 1);
  });

  it("projected profit is positive for every EXIT-VERIFIED liquidatable Morpho position at oracle parity", () => {
    const c = cand({
      collateralTier: "bluechip", collateralAsset: "WETH",
      priceSource: "oracle", collateralBalanceUsd: 10_000, borrowBalanceUsd: 500_000,
      expectedSeizeUsd: 10_000,
    });
    expect(projectedProfitUsd(c)).toBeGreaterThan(0);
  });
});

describe("exit price helpers", () => {
  it("salePriceRatio: dex/oracle when both known, else 1", () => {
    expect(salePriceRatio(cand({ dexPriceUsd: 0.97, oraclePriceUsd: 1.0, priceSource: "dex" }))).toBeCloseTo(0.97, 9);
    expect(salePriceRatio(cand({ dexPriceUsd: null, oraclePriceUsd: 1.0, priceSource: "none" }))).toBe(1);
    expect(salePriceRatio(cand({ dexPriceUsd: 0.99, oraclePriceUsd: null, priceSource: "dex" }))).toBe(1);
  });
  it("exitCapUsd scales the one-sided depth by EXIT_DEPTH_FRACTION (default 5%)", () => {
    expect(exitCapUsd(2_000_000)).toBe(100_000);
    expect(exitCapUsd(null)).toBe(0);
    expect(exitCapUsd(0)).toBe(0);
  });
  it("depthImpactBps: flat 50bps + 100bps per 1% of book consumed, capped at 1000", () => {
    expect(depthImpactBps(10_000, 1_000_000)).toBeCloseTo(51, 9);
    expect(depthImpactBps(100_000, 1_000_000)).toBeCloseTo(60, 9);
    expect(depthImpactBps(1_000_000, 1_000_000)).toBe(150);
    expect(depthImpactBps(15_000_000, 1_000_000)).toBe(1000); // capped
    expect(depthImpactBps(10_000, 0)).toBe(SLIPPAGE_BPS);
  });
});

describe("projectedProfitUsd - Ionic (compound-v2 style, unchanged)", () => {
  const ionicCand = (over: Partial<LiquidationCandidate>) =>
    cand({ protocol: "ionic", liquidationThreshold: 0.9, ...over });

  it("close-factor bound: repay 50% of borrow, keep the 8% bonus on it", () => {
    // B=10,000 C=20,000 -> repay 5,000, seize 5,400, edge 400, slip 27, gas 0.054
    const c = ionicCand({ borrowBalanceUsd: 10_000, collateralBalanceUsd: 20_000 });
    expect(projectedProfitUsd(c)).toBeCloseTo(400 - 0.054 - 27, 1);
  });

  it("collateral-bound: cannot seize more than is posted", () => {
    // B=100,000 C=500 -> repay 500/1.08, seize 500
    const c = ionicCand({ borrowBalanceUsd: 100_000, collateralBalanceUsd: 500 });
    expect(ionicSeizedUsd(100_000, 500)).toBeCloseTo(500, 6);
    expect(projectedProfitUsd(c)).toBeCloseTo(500 * (IONIC_INCENTIVE / (1 + IONIC_INCENTIVE)) - 0.054 - 2.5, 1);
  });
});