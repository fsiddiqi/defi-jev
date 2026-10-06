import type { LiquidationCandidate, Protocol } from "../types.js";

// Pure scan mathematics, extracted from src/scan.ts so the pricing decision
// (indexer USD vs on-chain oracle) can be unit tested without GraphQL/RPC.

export function estimateGas(protocol: Protocol): number {
  return protocol === "ionic" ? 750_000 : 900_000;
}

// Deterministic hash of everything Jev sees about a candidate. A cached
// decision stays valid while the input vector is bit-identical, so the bot can
// skip re-judging unchanged candidates entirely (steady-state Jev cost -> 0)
// instead of re-judging them on a fixed timer.
export function candidateContextHash(candidate: LiquidationCandidate): string {
  const inputs = [
    candidate.protocol,
    candidate.borrower,
    candidate.collateralAsset,
    candidate.collateralTier,
    candidate.borrowAsset,
    candidate.currentLtv.toFixed(6),
    candidate.liquidationThreshold.toFixed(6),
    candidate.healthFactor.toFixed(9),
    candidate.collateralBalanceUsd.toFixed(4),
    candidate.borrowBalanceUsd.toFixed(4),
    candidate.expectedSeizeUsd.toFixed(4),
    candidate.oracleFreshnessSec,
    candidate.gasPriceGwei.toFixed(6),
    candidate.estimatedExecutionGas,
    candidate.recentPriceMovePct30m.toFixed(6),
    candidate.cascadeScore.toFixed(6),
    candidate.competitionLast10Blocks,
    candidate.ageBlocks,
    candidate.priceSource,
    candidate.oracleAgeSec ?? "nil",
    candidate.dexPriceUsd?.toFixed(10) ?? "nil",
    candidate.exitLiquidityUsd?.toFixed(4) ?? "nil",
    candidate.oraclePriceUsd?.toFixed(10) ?? "nil",
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