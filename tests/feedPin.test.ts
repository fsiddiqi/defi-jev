import { beforeEach, describe, expect, it } from "vitest";
import { addFeedEntry, getState, type FeedEntry } from "../src/server.js";

// Regression: discovery emits ~600 rows/cycle (Ethereum alone ~500) while the
// feed cap is 600 — a naive head-trim evicted the only rows that can ever sign
// a tx (executable chains). Executable-chain rows must survive any
// discovery-heavy cycle.
describe("feed cap - executable-chain rows are pinned", () => {
  // fixed-width borrower ids — naive template+padEnd collides (0xeth1 == 0xeth10)
  const row = (chainId: number, tag: string, i: number): Omit<FeedEntry, "scans"> => ({
    timestamp: new Date().toISOString(),
    protocol: "morpho-blue",
    chainId,
    borrower: `0x${tag}${String(i).padStart(6, "0")}`,
    collateralAsset: "WETH",
    borrowAsset: "USDC",
    currentLtv: 0.9,
    healthFactor: 0.95,
    expectedSeizeUsd: 1000,
    projectedProfitUsd: 300,
    gasPriceGwei: 0.05,
    priceSource: "dex",
    exitLiquidityUsd: 50_000,
    dexPriceUsd: 2500,
    oraclePriceUsd: 2500,
    saleVenue: "univ3",
    oracleAgeSec: 5,
    decision: null,
    gateResult: null,
  });

  beforeEach(() => {
    getState().feed = [];
  });

  it("keeps every executable-chain row even at 3x the cap", () => {
    // interleave so executable rows land early (they get trimmed first
    // without the pin)
    for (let i = 0; i < 600; i++) addFeedEntry(row(1, "e", i));
    for (let i = 0; i < 5; i++) addFeedEntry(row(8453, "b", i));
    for (let i = 600; i < 1200; i++) addFeedEntry(row(1, "e", i));

    const feed = getState().feed;
    expect(feed.length).toBe(600);
    const baseRows = feed.filter((e) => e.chainId === 8453);
    expect(baseRows.length).toBe(5);
    // non-executable rows absorb the entire overflow
    expect(feed.filter((e) => e.chainId === 1).length).toBe(595);
  });

  it("still respects the cap when executable rows alone exceed it", () => {
    for (let i = 0; i < 700; i++) addFeedEntry(row(8453, "b", i));
    expect(getState().feed.length).toBe(600);
  });

  it("re-added rows bump to top without breaking the pin", () => {
    for (let i = 0; i < 610; i++) addFeedEntry(row(1, "e", i));
    addFeedEntry(row(8453, "b", 0));
    for (let i = 0; i < 610; i++) addFeedEntry(row(1, "e", i));
    const feed = getState().feed;
    expect(feed.length).toBe(600);
    expect(feed.some((e) => e.chainId === 8453)).toBe(true);
  });
});
