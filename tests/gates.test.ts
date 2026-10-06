import { describe, expect, it } from "vitest";
import { dataIntegrityGate, hfFromBalances, preJevGates } from "../src/lib/gates.js";
import type { ExecutionConfig, LiquidationCandidate } from "../src/types.js";

/** Build a candidate fixture; only fields the gates read matter. */
function cand(over: Partial<LiquidationCandidate>): LiquidationCandidate {
  return {
    protocol: "morpho-blue",
    borrower: "0x0000000000000000000000000000000000000000",
    collateralAsset: "USR",
    collateralTier: "long-tail",
    borrowAsset: "USDC",
    currentLtv: 0,
    liquidationThreshold: 0.915,
    healthFactor: 1.0,
    collateralBalanceUsd: 100,
    borrowBalanceUsd: 100,
    seizePct: 0.08,
    expectedSeizeUsd: 100,
    oracleFreshnessSec: 5,
    gasPriceGwei: 0.02,
    estimatedExecutionGas: 900_000,
    recentPriceMovePct30m: 0,
    cascadeScore: 0,
    competitionLast10Blocks: 0,
    ageBlocks: 999,
    oraclePriceUsd: null,
    oracleAgeSec: null,
    dexPriceUsd: null,
    exitLiquidityUsd: null,
    priceSource: "none",
    saleVenue: null,
    watch: false,
    ...over,
  };
}

const CONFIG: ExecutionConfig = {
  maxConcurrent: 5,
  minSeizeUsd: 100,
  minProfitForecastUsd: 1,
  minJevConfidence: 0.55,
  minJevSafety: 0.1,
  marginBufferUsd: 10,
  gasCostPctOfProfitMax: 0.4,
  oracleDivergenceBps: 50,
};

describe("hfFromBalances", () => {
  it("computes HF = collateralUsd * lltv / borrowUsd", () => {
    // 569.9 USR at ~$1 vs 13,933.85 borrowed, lltv 0.915 => HF ~0.0374
    expect(
      hfFromBalances({ collateralBalanceUsd: 569.9, borrowBalanceUsd: 13933.85, liquidationThreshold: 0.915 }),
    ).toBeCloseTo(0.037424, 5);
  });

  it("returns null when collateral or borrow is zero", () => {
    expect(hfFromBalances({ collateralBalanceUsd: 0, borrowBalanceUsd: 100, liquidationThreshold: 0.9 })).toBeNull();
    expect(hfFromBalances({ collateralBalanceUsd: 100, borrowBalanceUsd: 0, liquidationThreshold: 0.9 })).toBeNull();
  });
});

describe("dataIntegrityGate - the USR false-block regression", () => {
  // Real data pulled live for 0x64d7B0 (USR/USDC, lltv 0.915):
  //   healthFactor 0.037425... is computed by Morpho from the on-chain oracle
  //   (USR = 1.000049 USDC). The indexer's collateralUsd field ($46.62) prices
  //   USR at ~$0.08 - a 12x corruption. Both figures below are the SAME
  //   position: the first uses the corrupt indexer field, the second uses the
  //   oracle-consistent $569.9 (= 569.9 USR on-chain).

  it("BLOCKS the position when collateralUsd comes from the corrupt indexer field (91.8% mismatch)", () => {
    const v = dataIntegrityGate(
      cand({
        healthFactor: 0.037425497582058265,
        collateralBalanceUsd: 46.622987263105834, // indexer field, USR priced $0.08
        borrowBalanceUsd: 13933.847422385637,
        liquidationThreshold: 0.915,
      }),
      0.3,
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("91.8%");
  });

  it("PASSES the same position when collateral is oracle-priced (~$1/USR)", () => {
    const v = dataIntegrityGate(
      cand({
        healthFactor: 0.037425497582058265,
        collateralBalanceUsd: 569.9, // 569.9 USR * 1.000049 USDC oracle price
        borrowBalanceUsd: 13933.847422385637,
        liquidationThreshold: 0.915,
      }),
      0.3,
    );
    expect(v.pass).toBe(true);
  });

  it("passes a 0.0% mismatch row (RSS-style oracle-priced candidates)", () => {
    const v = dataIntegrityGate(
      cand({ healthFactor: 0.4447, collateralBalanceUsd: 1399926.15, borrowBalanceUsd: 2424128.16, liquidationThreshold: 0.9 }),
      0.3,
    );
    expect(v.pass).toBe(true);
  });

  it("passes small mismatches below the tolerance", () => {
    const v = dataIntegrityGate(cand({ healthFactor: 0.499, collateralBalanceUsd: 100, borrowBalanceUsd: 100, liquidationThreshold: 0.5 }), 0.3);
    expect(v.pass).toBe(true);
  });

  it("blocks a direction conflict (balances healthy, indexer underwater)", () => {
    const v = dataIntegrityGate(cand({ healthFactor: 1.2, collateralBalanceUsd: 100, borrowBalanceUsd: 300, liquidationThreshold: 0.5 }), 0.3);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("direction conflict");
  });

  it("does not block when there is no health factor to contradict", () => {
    const v = dataIntegrityGate(cand({ healthFactor: 0 }), 0.3);
    expect(v.pass).toBe(true);
  });
});

describe("preJevGates", () => {
  it("blocks stale oracle", () => {
    expect(preJevGates(cand({ oracleFreshnessSec: 61 }), CONFIG).pass).toBe(false);
    expect(preJevGates(cand({ protocol: "ionic", oracleFreshnessSec: 301 }), CONFIG).pass).toBe(false);
  });
  it("blocks exaggerated gas", () => {
    expect(preJevGates(cand({ gasPriceGwei: 101 }), CONFIG).pass).toBe(false);
  });
  it("blocks seize below the configured floor", () => {
    const v = preJevGates(cand({ expectedSeizeUsd: 99 }), CONFIG);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("Seize too small");
  });
  it("blocks positions too close to the liquidation line (HF > 0.98)", () => {
    const v = preJevGates(cand({ healthFactor: 0.989 }), CONFIG);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("LTV spread too tight");
  });
  it("passes an otherwise clean candidate", () => {
    expect(preJevGates(cand({ healthFactor: 0.9 }), CONFIG).pass).toBe(true);
  });
});