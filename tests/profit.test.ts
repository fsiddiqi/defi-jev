import { describe, expect, it } from "vitest";
import {
  gasCostUsd,
  IONIC_INCENTIVE,
  ionicSeizedUsd,
  morphoEdgeOfSeize,
  morphoIncentiveFactor,
  morphoSeizedUsd,
  projectedProfitUsd,
  SLIPPAGE_BPS,
} from "../src/profit.js";
import type { LiquidationCandidate } from "../src/types.js";

/** Candidate fixture. projectedProfitUsd/expectedSeizeUsd now DERIVE everything
 *  from balances + liquidationThreshold, so expectedSeizeUsd/seizePct in the
 *  fixture are informational only (what the pipeline would have computed). */
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
    ...over,
  };
}

const RSS = cand({}); // 0xbF4F29, lltv 0.90
const USR_BIG = cand({
  collateralAsset: "USR",
  liquidationThreshold: 0.915,
  collateralBalanceUsd: 773_674.44, // 0xA85f4F (oracle-priced)
  borrowBalanceUsd: 20_496_279.15,
});

describe("gasCostUsd", () => {
  it("uses estimatedExecutionGas * gasPriceGwei * 1e-9 * $3000/ETH", () => {
    expect(gasCostUsd(cand({ estimatedExecutionGas: 900_000, gasPriceGwei: 0.02 }))).toBeCloseTo(0.054, 6);
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

describe("projectedProfitUsd - honest Morpho economics (pinned)", () => {
  it("RSS 0xbF4F29: ~$41,999 edge - gas - slippage, NOT $192,967 (=whole seize)", () => {
    // seize 1,399,976 * 3% edge = 41,999.28; slippage 50bps on seized; gas ~$0.05
    const profit = projectedProfitUsd(RSS);
    const slippage = (1_399_976.15 * SLIPPAGE_BPS) / 10_000;
    expect(profit).toBeCloseTo(41_999.28 - 0.054 - slippage, 1);
    expect(profit).toBeLessThan(42_500);
    expect(profit).toBeGreaterThan(34_000);
  });

  it("USR 0xA85f4F: ~$19,729 edge on the $773.7K seize, not $769,831", () => {
    // seize 773,674 * 2.55% = 19,728.70; slippage 3,868.37; gas ~$0.05
    const profit = projectedProfitUsd(USR_BIG);
    const slippage = (773_674.44 * SLIPPAGE_BPS) / 10_000;
    expect(profit).toBeCloseTo(19_728.70 - 0.054 - slippage, 1);
  });

  it("profit is a fraction of the seized value, bounded by the on-chain edge", () => {
    for (const c of [RSS, USR_BIG]) {
      // edge is 2.55%-3.00% of seized for these markets; never 100%
      expect(projectedProfitUsd(c)).toBeLessThanOrEqual(0.031 * c.collateralBalanceUsd);
      expect(projectedProfitUsd(c)).toBeGreaterThan(0.02 * c.collateralBalanceUsd);
    }
  });

  it("is positive (no gas blowout) for every liquidatable Morpho position", () => {
    expect(projectedProfitUsd(RSS)).toBeGreaterThan(0);
    expect(projectedProfitUsd(USR_BIG)).toBeGreaterThan(0);
  });
});

describe("projectedProfitUsd - Ionic (compound-v2 style)", () => {
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