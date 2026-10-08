import { describe, expect, it } from "vitest";
import { v2Quote, v3Quote } from "../src/lib/prices.js";

// Pure pool math — pinned with synthetic reserves/slot0 values so the DEX
// price and depth semantics are exact and reviewable before any RPC is used.

const Q96 = 2 ** 96;
// sqrtPriceX96 for a pool whose RAW amount1/amount0 ratio is `rawSq`
// (e.g. USDC(6)/WETH(18) at $3000/WETH: 3000e6/1e18 = 3e-9).
const sqrtPriceX96Of = (rawSq: number) =>
  BigInt(Math.round(Math.sqrt(rawSq) * Q96));

describe("v2Quote - constant product", () => {
  it("USR(18) / USDC(6): 1000 vs 1000 tokens -> $1 spot, $1000 one-sided depth", () => {
    const q = v2Quote([1000n * 10n ** 18n, 1000n * 10n ** 6n], 18, 6, true, 1);
    expect(q.priceUsd).toBeCloseTo(1, 9);
    expect(q.depthUsd).toBeCloseTo(1000, 6);
  });

  it("WETH(18) / USDC(6): 10 WETH vs 3000 USDC -> $300 spot", () => {
    const q = v2Quote([10n * 10n ** 18n, 3000n * 10n ** 6n], 18, 6, true, 1);
    expect(q.priceUsd).toBeCloseTo(300, 6);
    expect(q.depthUsd).toBeCloseTo(3000, 6); // min(10*300, 3000)
  });

  it("token0/token1 order is irrelevant (pool sorts by address)", () => {
    // same pair, token0 = USDC this time
    const q = v2Quote([3000n * 10n ** 6n, 10n * 10n ** 18n], 18, 6, false, 1);
    expect(q.priceUsd).toBeCloseTo(300, 6);
    expect(q.depthUsd).toBeCloseTo(3000, 6);
  });

  it("quoteUsd applies to the quote token: WETH-quoted pool at live ETH price", () => {
    // collateral(18) vs 1 WETH(18) per 1000 coll -> 0.001 WETH/coll * $2687.55
    const q = v2Quote([1000n * 10n ** 18n, 1n * 10n ** 18n], 18, 18, true, 2687.55);
    expect(q.priceUsd).toBeCloseTo(0.001 * 2687.55, 9);
    expect(q.depthUsd).toBeCloseTo(2687.55, 6); // min(1000*2.68755, 1*2687.55)
  });

  it("zero-reserve guard", () => {
    expect(v2Quote([0n, 1000n * 10n ** 6n], 18, 6, true, 1).priceUsd).toBe(0);
  });
});

describe("v3Quote - slot0 sqrtPriceX96", () => {
  it("coll token0 (WETH): spot = sq * 10^(dec0-dec1) * quoteUsd", () => {
    // WETH(18)/USDC(6) pool: raw sq = 3000e6/1e18 = 3e-9 -> price 3000 USDC/WETH
    const sqrtX96 = sqrtPriceX96Of(3e-9);
    const q = v3Quote(sqrtX96, 1_000_000n, 18, 6, true, 1);
    expect(q.priceUsd).toBeCloseTo(3000, 0);
    expect(q.depthUsd).toBeGreaterThan(0);
    expect(q.depthUsd).toBeLessThan(1); // thin ±10% band depth, correctly tiny
  });

  it("coll token1 (WETH, token0=USDC): inverted decimals", () => {
    // token0=USDC(6), token1=WETH(18); raw sq = 1e18/3000e6 = 3.3333e8
    const sqrtX96 = sqrtPriceX96Of(1e18 / (3000 * 10 ** 6));
    const q = v3Quote(sqrtX96, 1_000_000n, 18, 6, false, 1);
    expect(q.priceUsd).toBeCloseTo(3000, 0);
  });

  it("quoteUsd scales the V3 price", () => {
    const sqrtX96 = sqrtPriceX96Of(3e-9);
    const q = v3Quote(sqrtX96, 1_000_000n, 18, 6, true, 2687.55);
    expect(q.priceUsd).toBeCloseTo(3000 * 2687.55, 0);
  });

  it("zero-liquidity guard", () => {
    const sqrtX96 = sqrtPriceX96Of(3e-9);
    expect(v3Quote(sqrtX96, 0n, 18, 6, true, 1).priceUsd).toBe(0);
  });
});