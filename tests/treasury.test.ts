import { describe, expect, it } from "vitest";
import { usdValue } from "../src/lib/treasury.js";

// Money shown in the simple UI must never be invented: USDC is pegged 1:1,
// ETH/WETH use the live ETH price, and anything unknown reports null (never a
// guessed price).
describe("usdValue - honest USD for treasury holdings", () => {
  it("prices USDC at 1:1", () => {
    expect(usdValue("USDC", 62.432385, 2529)).toBeCloseTo(62.432385, 6);
  });

  it("prices ETH and WETH at the live ETH price", () => {
    expect(usdValue("ETH", 0.0011527789, 2529.04)).toBeCloseTo(2.9154, 3);
    expect(usdValue("WETH", 0.00154364, 2529.04)).toBeCloseTo(3.9039, 3);
  });

  it("returns null for a token with no honest price", () => {
    expect(usdValue("RSS", 1_000_000, 2529)).toBeNull();
    expect(usdValue("WBTC", 0.1, 2529)).toBeNull();
  });
});