import { describe, expect, it } from "vitest";
import { dataIntegrityGate, hfFromBalances, preJevGates, realizabilityGate, DEFAULT_MAX_ORACLE_DISCOUNT_PCT } from "../src/lib/gates.js";
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

/** A dex-priced exit that clears every realizability check: pool deep enough,
 *  selling at the oracle price. "Clean" now means REALIZABLE — a candidate
 *  with no exit used to pass preJevGates and got judged by Jev for nothing. */
const REALIZABLE = {
  priceSource: "dex" as const,
  saleVenue: "aerodrome-v2 WETH/USDC volatile",
  dexPriceUsd: 1.0,
  oraclePriceUsd: 1.0,
  exitLiquidityUsd: 100_000, // cap = $5,000 >> seize $100
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
  it("passes an otherwise clean (and realizable) candidate", () => {
    expect(preJevGates(cand({ healthFactor: 0.9, ...REALIZABLE }), CONFIG).pass).toBe(true);
  });
  it("blocks a clean-shaped candidate with no exit venue (was: reached Jev, $0 by construction)", () => {
    const v = preJevGates(cand({ healthFactor: 0.9 }), CONFIG);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("exit not verifiable");
  });
});

describe("realizabilityGate - the arithmetic Jev used to do from its prompt", () => {
  it("BLOCKS the live RSS regression: $1.4M seize against a $1.65 pool, dex price 36,900x below oracle", () => {
    // Real feed row (2026-10-08): borrower 0xbF4F2939, RSS/USDC, HF 0.426.
    const v = realizabilityGate(
      cand({
        collateralAsset: "RSS",
        collateralTier: "long-tail",
        healthFactor: 0.42637959712610474,
        expectedSeizeUsd: 1_399_533.03,
        priceSource: "dex",
        saleVenue: "aerodrome-v2 RSS/USDC volatile",
        dexPriceUsd: 0.000027062216411540926,
        oraclePriceUsd: 0.999666448965446,
        exitLiquidityUsd: 1.645061,
      }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("can't clear seize");
  });

  it("blocks a trap token whose dex price is a rounding error vs the oracle", () => {
    const v = realizabilityGate(
      cand({
        ...REALIZABLE,
        expectedSeizeUsd: 100, // small enough for the depth cap
        dexPriceUsd: 0.5, // 50% below oracle — even the 1.15 bonus cannot cover it
        oraclePriceUsd: 1.0,
      }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("below liquidation oracle");
  });

  it("passes a ratio just above the floor (dex 14% below oracle still clears max bonus 1/1.15)", () => {
    expect(
      realizabilityGate(cand({ ...REALIZABLE, dexPriceUsd: 0.86, oraclePriceUsd: 1.0 })).pass,
    ).toBe(true);
  });

  it("blocks a ratio just below the floor (15% discount)", () => {
    expect(DEFAULT_MAX_ORACLE_DISCOUNT_PCT).toBe(0.15);
    expect(
      realizabilityGate(cand({ ...REALIZABLE, dexPriceUsd: 0.84, oraclePriceUsd: 1.0 })).pass,
    ).toBe(false);
  });

  it("tolerance is configurable", () => {
    const c = cand({ ...REALIZABLE, dexPriceUsd: 0.97, oraclePriceUsd: 1.0 });
    expect(realizabilityGate(c, 0.01).pass).toBe(false);
    expect(realizabilityGate(c, 0.05).pass).toBe(true);
  });

  it("passes a tier-verified stable priced by oracle with no pool at all", () => {
    const v = realizabilityGate(
      cand({ collateralTier: "stable", priceSource: "oracle", dexPriceUsd: null, exitLiquidityUsd: null }),
    );
    expect(v.pass).toBe(true);
  });

  it("blocks when only a sliver of book exists (cap = 5% of depth)", () => {
    const v = realizabilityGate(
      cand({ ...REALIZABLE, expectedSeizeUsd: 5_000.01, exitLiquidityUsd: 100_000 }), // cap exactly $5,000
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("cap $5000.00");
  });
});