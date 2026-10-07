import type { LiquidationCandidate } from "../types.js";

// Pure scan mathematics, extracted from src/scan.ts so the pricing decision
// (indexer USD vs on-chain oracle) can be unit tested without GraphQL/RPC.

// Morpho Blue execution: liquidate() + single swap inside one tx. 900k is a
// conservative ceiling — the live figure will be measured by --self-test and
// can only shrink (over-estimating gas makes projected profit conservative,
// never optimistic).
export function estimateGas(): number {
  return 900_000;
}

// Quantizers for the context hash. The hash must change when Jev's DECISION
// could flip — and only then.
//
// Hashing raw continuous fields made the cache useless in production: gas
// price ticks every block, oracle age counts up every second, pool reserves
// move on any swap, so ~92% of candidates were bit-different at every 30-min
// re-eval expiry and the bot re-judged the entire book twice an hour for
// decisions that had not changed (measured: 1.8M input tokens/hr, 9x the
// spec's per-candidate budget). Every continuous field is therefore rounded
// to the number of significant digits at which a gate can actually flip:
//   - USD magnitudes (collateral/borrow/seize/depth): 3 sig — on five-figure
//     positions the profit gates live at $200-$500, i.e. ~0.1-1%;
//   - LTV: 2 sig (~1pp — the "spread too tight" reasoning is ~2pp);
//   - health factor: 3 sig (~0.01 near the 1.0 line, ~1% deep underwater);
//   - oracle price: 4 sig (moves rarely; re-read on-chain, not per block);
//   - gas price: 1 sig — a decision changes when gas roughly doubles or
//     halves, not when it wobbles 5%;
//   - oracle age: bucketed into the freshness bands the rules themselves use
//     (~30s morpho), so aging inside a band is free.
const sig = (v: number, digits: number): string => v.toPrecision(digits);

const ageBand = (sec: number): number =>
  sec < 60 ? 0 : sec < 300 ? 1 : sec < 1800 ? 2 : 3;

// Deterministic hash of everything Jev sees about a candidate. A cached
// decision stays valid while the quantized input vector is identical, so the
// bot can skip re-judging unchanged candidates entirely (steady-state Jev
// cost -> 0) instead of re-judging them on a fixed timer.
export function candidateContextHash(candidate: LiquidationCandidate): string {
  const inputs = [
    candidate.protocol,
    candidate.borrower,
    candidate.collateralAsset,
    candidate.collateralTier,
    candidate.borrowAsset,
    sig(candidate.currentLtv, 2),
    candidate.liquidationThreshold.toFixed(6), // static per market
    sig(candidate.healthFactor, 3),
    sig(candidate.collateralBalanceUsd, 3),
    sig(candidate.borrowBalanceUsd, 3),
    sig(candidate.expectedSeizeUsd, 3),
    ageBand(candidate.oracleFreshnessSec),
    sig(candidate.gasPriceGwei, 1),
    candidate.estimatedExecutionGas,
    sig(candidate.recentPriceMovePct30m, 2),
    sig(candidate.cascadeScore, 2),
    candidate.competitionLast10Blocks,
    candidate.ageBlocks,
    candidate.priceSource,
    candidate.oracleAgeSec === null ? "nil" : ageBand(candidate.oracleAgeSec),
    candidate.dexPriceUsd === null ? "nil" : sig(candidate.dexPriceUsd, 3),
    candidate.exitLiquidityUsd === null ? "nil" : sig(candidate.exitLiquidityUsd, 3),
    candidate.oraclePriceUsd === null ? "nil" : sig(candidate.oraclePriceUsd, 4),
    candidate.saleVenue ?? "nil",
    candidate.watch ? "watch" : "live",
  ].join("|");
  let h = 5381;
  for (let i = 0; i < inputs.length; i++) h = ((h << 5) + h + inputs.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Morpho on-chain oracle: `price()` returns loan-asset wei per whole collateral
// unit, scaled 1e18. Value the collateral's loan-wei as a fraction of the
// total counted borrow assets, then scale to USD.
export function collateralUsdFromOracle(
  state: { collateral: string; borrowAssets: string },
  collateralDecimals: number,
  price: bigint,
  borrowUsd: number,
): number {
  const borrowAssets = Number(state.borrowAssets);
  if (borrowAssets <= 0) return 0;
  const valueLoanWei = (Number(state.collateral) / 10 ** collateralDecimals) * (Number(price) / 1e18);
  return (valueLoanWei * borrowUsd) / borrowAssets;
}

export interface CollateralResolution {
  collateralUsd: number;
  oraclePriced: boolean;
  repriceReason?: string;
}

// Decide which USD figure to trust for a collateral position:
//  - the GraphQL `state.collateralUsd` indexer field, or
//  - USD derived from the market's on-chain oracle (what the protocol actually
//    uses to compute health factor and run liquidations).
//
// The indexer field is corrupt for some markets. Real case (Base, USR/USDC
// market 0xff0f2bd5): the indexer prices 569.9 USR at $46.62 (~$0.08/USR)
// while its own healthFactor (0.0374) — computed from the on-chain oracle,
// which prices USR at 1.000049 USDC — implies ~$570. Re-price from the oracle
// whenever the indexer field is missing OR produces the same HF mismatch the
// dataIntegrityGate would flag. Otherwise keep the indexer figure.
export function resolveCollateralUsd(opts: {
  indexerUsd: number;
  oraclePrice: bigint | null;
  state: { collateral: string; borrowAssets: string };
  collateralDecimals: number;
  borrowUsd: number;
  healthFactor: number;
  liquidationThreshold: number;
  maxMismatchPct: number;
}): CollateralResolution {
  const {
    indexerUsd,
    oraclePrice,
    healthFactor: hf,
    liquidationThreshold: lltv,
    borrowUsd,
  } = opts;

  // Mirror the dataIntegrityGate mismatch metric exactly, so the scan and the
  // gate agree on what "inconsistent data" means.
  const hfFromUsd = borrowUsd > 0 && indexerUsd > 0 ? (lltv * indexerUsd) / borrowUsd : null;
  const mismatchPct = hfFromUsd !== null && hf > 0 ? Math.abs(hfFromUsd - hf) / hf : null;
  const reprice =
    indexerUsd === 0 || (mismatchPct !== null && mismatchPct > opts.maxMismatchPct);

  if (reprice && oraclePrice !== null && oraclePrice > 0n) {
    const oracleUsd = collateralUsdFromOracle(
      opts.state,
      opts.collateralDecimals,
      oraclePrice,
      borrowUsd,
    );
    if (oracleUsd > 0) {
      const reason =
        indexerUsd === 0
          ? "indexer price missing"
          : `indexer price inconsistent with HF (${(mismatchPct! * 100).toFixed(1)}% mismatch)`;
      return { collateralUsd: oracleUsd, oraclePriced: true, repriceReason: reason };
    }
  }
  return { collateralUsd: indexerUsd, oraclePriced: false };
}