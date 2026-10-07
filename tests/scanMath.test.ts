import { describe, expect, it } from "vitest";
import {
  candidateContextHash,
  collateralUsdFromOracle,
  estimateGas,
  resolveCollateralUsd,
} from "../src/lib/scanMath.js";
import type { LiquidationCandidate } from "../src/types.js";

const label = "0x0000000000000000000000000000000000000000";

function cand(over: Partial<LiquidationCandidate>): LiquidationCandidate {
  return {
    protocol: "morpho-blue",
    borrower: label,
    collateralAsset: "USR",
    collateralTier: "listed",
    borrowAsset: "USDC",
    currentLtv: 24.5,
    liquidationThreshold: 0.915,
    healthFactor: 0.0374,
    collateralBalanceUsd: 569.9041,
    borrowBalanceUsd: 13933.85,
    seizePct: 0.0255,
    expectedSeizeUsd: 569.9041,
    oracleFreshnessSec: 5,
    gasPriceGwei: 0.02,
    estimatedExecutionGas: 900_000,
    recentPriceMovePct30m: 0,
    cascadeScore: 0,
    competitionLast10Blocks: 0,
    ageBlocks: 999,
    oraclePriceUsd: 1.0000492,
    oracleAgeSec: 30,
    dexPriceUsd: null,
    exitLiquidityUsd: null,
    priceSource: "none",
    saleVenue: null,
    watch: false,
    ...over,
  };
}

describe("candidateContextHash - skip re-judging unchanged candidates", () => {
  it("is stable for identical candidates (decision reusable)", () => {
    expect(candidateContextHash(cand({}))).toBe(candidateContextHash(cand({})));
  });
  it("changes when any Jev-relevant field moves, so a changed position is re-judged", () => {
    const base = candidateContextHash(cand({}));
    expect(candidateContextHash(cand({ healthFactor: 0.038 }))).not.toBe(base);
    expect(candidateContextHash(cand({ collateralBalanceUsd: 620 }))).not.toBe(base);
    expect(candidateContextHash(cand({ gasPriceGwei: 0.5 }))).not.toBe(base);
    expect(candidateContextHash(cand({ currentLtv: 26 }))).not.toBe(base); // LTV is 2-sig: 24.5 -> 26 is a >1pp move
    expect(candidateContextHash(cand({ competitionLast10Blocks: 3 }))).not.toBe(base);
    expect(candidateContextHash(cand({ collateralTier: "long-tail" }))).not.toBe(base);
    expect(candidateContextHash(cand({ priceSource: "dex" }))).not.toBe(base);
    expect(candidateContextHash(cand({ dexPriceUsd: 0.98, exitLiquidityUsd: 500_000, priceSource: "dex" }))).not.toBe(base);
    expect(candidateContextHash(cand({ oracleAgeSec: 120 }))).not.toBe(base);
  });
  // The production bug this guards: raw fields jitter on EVERY scan (gas
  // ticks, oracle age counts up, reserves move), so hashing them raw invalidated
  // ~92% of the cache at each 30-min expiry and the whole book was re-judged
  // twice an hour. Jitter below gate resolution must hash identically.
  it("is stable under sub-threshold jitter (gas, oracle age, prices, reserves)", () => {
    const base = candidateContextHash(cand({}));
    expect(candidateContextHash(cand({ oracleFreshnessSec: 47 }))).toBe(base);   // still <60s band
    expect(candidateContextHash(cand({ gasPriceGwei: 0.0204 }))).toBe(base);     // 2% gas wobble
    expect(candidateContextHash(cand({ collateralBalanceUsd: 569.95 }))).toBe(base);
    expect(candidateContextHash(cand({ healthFactor: 0.03741 }))).toBe(base);
    expect(candidateContextHash(cand({ dexPriceUsd: 0.9801, exitLiquidityUsd: 500_200, priceSource: "dex" })))
      .toBe(candidateContextHash(cand({ dexPriceUsd: 0.98, exitLiquidityUsd: 500_000, priceSource: "dex" })));
  });
  it("re-judges when a watched position crosses into liquidation", () => {
    const watch = candidateContextHash(cand({ watch: true, healthFactor: 1.02 }));
    const live = candidateContextHash(cand({ watch: false, healthFactor: 1.02 }));
    expect(watch).not.toBe(live);
    // and the HF move alone (1.02 -> 0.997) also re-judges, double safety
    expect(candidateContextHash(cand({ watch: true, healthFactor: 0.997 }))).not.toBe(watch);
  });
  it("distinguishes different borrowers (the model sees the address)", () => {
    const other = cand({ borrower: "0x1111111111111111111111111111111111111111" });
    expect(candidateContextHash(other)).not.toBe(candidateContextHash(cand({})));
  });
});

// ── Discovery criterion ──────────────────────────────────────────────────────
// The bot's job is to DISCOVER executable trades, even from a corrupt feed.
// These tests pin the real Base mainnet numbers that were hiding $100K+ seize
// opportunities: Morpho's GraphQL `state.collateralUsd` prices USR ~12x too
// low, but the on-chain oracle (what liquidation actually prices off) says
// ~$1. resolveCollateralUsd must surface the oracle-consistent figure so the
// candidate reaches Jev for reflexive classification instead of being dropped.
//
// NOTE: Morpho Blue has no close factor — the scanner seizes the whole
// position (seized = collateral under the oracle-repriced figure), so "seize"
// here collapses to the collateral value itself. The honest profit edge on
// that seize is modeled in src/profit.ts (tests/profit.test.ts).

const USR_ORACLE_PRICE = 1000049922492130807169893n; // 1.000049 USDC per USR
const USR_STATE = {
  collateral: "569904052418986431031", // 569.904 USR (18 decimals)
  borrowAssets: "13934036268", // 13,934.04 USDC (6 decimals)
};

const RS_RS_STATE = {
  collateral: "1399926150000000000000000", // RSS raw amount (18 dec)
  borrowAssets: "2424128160560", // 2,424,128 USDC
};

describe("collateralUsdFromOracle (loan-wei => USD)", () => {
  it("prices the real USR position consistently with its health factor", () => {
    // 569.9 USR * 1.000049 USDC, then scaled by borrowUsd/borrowAssets => ~$569.9,
    // matching hf 0.0374 * $13,933.85 / 0.915. The indexer field says $46.62.
    const usd = collateralUsdFromOracle(USR_STATE, 18, USR_ORACLE_PRICE, 13933.847422385637);
    expect(usd).toBeCloseTo(569.92, 0);
  });
});

describe("resolveCollateralUsd - surfacing discoverable candidates", () => {
  const base = {
    oraclePrice: USR_ORACLE_PRICE,
    state: USR_STATE,
    collateralDecimals: 18,
    borrowUsd: 13933.847422385637,
    healthFactor: 0.037425497582058265,
    liquidationThreshold: 0.915,
    maxMismatchPct: 0.3,
  };

  it("re-prices from the on-chain oracle when the indexer field is 12x corrupt", () => {
    const r = resolveCollateralUsd({ ...base, indexerUsd: 46.622987263105834 });
    expect(r.oraclePriced).toBe(true);
    expect(r.collateralUsd).toBeCloseTo(569.92, 0);
    expect(r.repriceReason).toContain("91.8%");
  });

  it("keeps the indexer figure when it is already consistent with the health factor", () => {
    const r = resolveCollateralUsd({ ...base, indexerUsd: 569.9 });
    expect(r.oraclePriced).toBe(false);
    expect(r.collateralUsd).toBe(569.9);
  });

  it("falls back to the oracle when the indexer field is missing (long-tail path)", () => {
    const r = resolveCollateralUsd({ ...base, indexerUsd: 0 });
    expect(r.oraclePriced).toBe(true);
    expect(r.collateralUsd).toBeCloseTo(569.92, 0);
  });

  it("honestly returns 0 (no reprice) when no oracle price is available", () => {
    const r = resolveCollateralUsd({ ...base, indexerUsd: 0, oraclePrice: null });
    expect(r.oraclePriced).toBe(false);
    expect(r.collateralUsd).toBe(0);
  });
});

describe("discovery: corrupt feed data must not hide executable trades", () => {
  it("0x64d7B0: with the corrupted indexer field the seized value is $46 - below the floor; with the oracle price it is $569.9 - discoverable", () => {
    // Stage 1: the raw indexer field as the feed reported it (USR ~ $0.08).
    // Morpho seizes the whole position, so seized = collateral = $46.62 - below
    // the $100 floor, so the position silently vanishes from every scan (and its
    // row was also dropping out via the data-integrity gate).
    expect(46.622987263105834).toBeLessThan(100);

    // Stage 2: resolveCollateralUsd re-prices from the on-chain oracle (~$1/USR)
    // => ~$569.9 collateral, now a discoverable $569.9 seized value.
    const resolved = resolveCollateralUsd({
      oraclePrice: USR_ORACLE_PRICE,
      state: USR_STATE,
      collateralDecimals: 18,
      borrowUsd: 13933.847422385637,
      healthFactor: 0.037425497582058265,
      liquidationThreshold: 0.915,
      maxMismatchPct: 0.3,
      indexerUsd: 46.622987263105834,
    });
    expect(resolved.collateralUsd).toBeCloseTo(569.92, 0);
    expect(resolved.collateralUsd).toBeGreaterThanOrEqual(569.9);
  });

  it("0xA85f4F: $20.5M borrow vs ~$773K USR collateral - seize is collateral-bound at ~$773K once priced correctly", () => {
    const r = resolveCollateralUsd({
      oraclePrice: USR_ORACLE_PRICE,
      state: { collateral: "773674439705631389434945", borrowAssets: "20496556937232" },
      collateralDecimals: 18,
      borrowUsd: 20496279.15089553,
      healthFactor: 0.034539823212040216,
      liquidationThreshold: 0.915,
      maxMismatchPct: 0.3,
      indexerUsd: 63293.13398471366, // the corrupt indexer field ($0.08 pricing)
    });
    expect(r.oraclePriced).toBe(true);
    // 773,674.44 USR at 1.000049 USDC ≈ $773.7K collateral (the indexer said $63.3K):
    expect(r.collateralUsd).toBeGreaterThan(770_000);
    expect(r.collateralUsd).toBeLessThan(775_000);
    expect(r.collateralUsd).toBeGreaterThan(750_000);
  });

  it("surfaces long-tail candidates through the same path (RSS oracle-priced market)", () => {
    const r = resolveCollateralUsd({
      oraclePrice: 1000000000000000000000000n, // 1e24 => $1 RSS per USDC-weu basis, illustrative
      state: RS_RS_STATE,
      collateralDecimals: 18,
      borrowUsd: 2424128.16,
      healthFactor: 0.4446725024354419,
      liquidationThreshold: 0.9,
      maxMismatchPct: 0.3,
      indexerUsd: 0,
    });
    expect(r.oraclePriced).toBe(true);
    expect(r.collateralUsd).toBeGreaterThanOrEqual(100);
  });
});

describe("gas estimate", () => {
  it("estimates gas per protocol", () => {
    expect(estimateGas("morpho-blue")).toBe(900_000);
    expect(estimateGas("ionic")).toBe(750_000);
  });
});