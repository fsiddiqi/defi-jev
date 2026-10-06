import { describe, expect, it } from "vitest";
import { feedKey } from "../src/server.js";

// Regression: feed rows are keyed by (borrower, market). A borrower holding
// collateral in TWO markets (e.g. USR and wbCOIN) must not let one market's
// row overwrite the other with its venue/depth/decision.
describe("feedKey - one row per (borrower, market)", () => {
  it("same borrower + different collateral asset = different rows", () => {
    const b = "0xAAE415992E62228b30a1Dd25842CBACa75F8de0A";
    expect(feedKey({ borrower: b, collateralAsset: "USR", borrowAsset: "USDC" }))
      .not.toBe(feedKey({ borrower: b, collateralAsset: "wbCOIN", borrowAsset: "USDC" }));
  });
  it("case-insensitive on the borrower, exact on the assets", () => {
    const b = "0xAAE415992E62228b30a1Dd25842CBACa75F8de0A";
    expect(feedKey({ borrower: b.toLowerCase(), collateralAsset: "USR", borrowAsset: "USDC" }))
      .toBe(feedKey({ borrower: b, collateralAsset: "USR", borrowAsset: "USDC" }));
    expect(feedKey({ borrower: b, collateralAsset: "USR", borrowAsset: "USDC" }))
      .not.toBe(feedKey({ borrower: b, collateralAsset: "USR", borrowAsset: "WETH" }));
  });
  it("a position identity does NOT change when it crosses into liquidation (watch -> live stays one row)", () => {
    const b = "0xAAE415992E62228b30a1Dd25842CBACa75F8de0A";
    // At-risk and liquidatable forms of the same (borrower, market) produce the
    // same key — the row that read "watch" becomes the row that reads "passed/
    // blocked" when HF crosses, it is not duplicated.
    const atRisk = feedKey({ borrower: b, collateralAsset: "WETH", borrowAsset: "USDC" });
    const liquidated = feedKey({ borrower: b, collateralAsset: "WETH", borrowAsset: "USDC" });
    expect(atRisk).toBe(liquidated);
    // a different market of the same borrower stays separate
    expect(atRisk).not.toBe(feedKey({ borrower: b, collateralAsset: "cbBTC", borrowAsset: "USDC" }));
  });
});