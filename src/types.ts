// Shared types for the liquidation racing CLI

export type Protocol = "morpho-blue";

export type AssetTier =
  | "stable"
  | "bluechip"
  | "lrt"
  | "listed" // known sales venue (DEX pool / native redemption) but thin — USR, wbCOIN
  | "long-tail"; // no verifiable market — RSS, RLP, REIT, PT-* wrappers

export interface LiquidationCandidate {
  protocol: Protocol;
  chainId: number;
  /** Morpho Blue market id (keccak of the 5 market params) */
  marketId: `0x${string}` | null;
  borrower: `0x${string}`;
  collateralAsset: string;
  collateralTier: AssetTier;
  borrowAsset: string;
  currentLtv: number;
  liquidationThreshold: number;
  healthFactor: number;
  collateralBalanceUsd: number;
  borrowBalanceUsd: number;
  seizePct: number;
  expectedSeizeUsd: number;
  oracleFreshnessSec: number;
  gasPriceGwei: number;
  estimatedExecutionGas: number;
  recentPriceMovePct30m: number;
  cascadeScore: number;
  competitionLast10Blocks: number;
  ageBlocks: number;
  // Price facts — no fiction. What we can ACTUALLY sell seized collateral for.
  oraclePriceUsd: number | null;   // USD per collateral token from the market's on-chain oracle (price())
  oracleAgeSec: number | null;     // true on-chain oracle age from latestRoundData()/updatedAt(), null if unknowable
  dexPriceUsd: number | null;      // USD per collateral token on the best on-chain DEX pool (Aerodrome V2/V3), if any
  exitLiquidityUsd: number | null; // one-sided pool depth in USD at spot
  priceSource: "oracle" | "dex" | "none"; // authority for the EXIT price
  saleVenue: string | null;        // e.g. "aerodrome-v2 USR/USDC (stable)"
  /**
   * At-risk watchlist row (HF in (1.0, WATCH_HF_MAX]): not yet liquidatable.
   * Judged for a WARM verdict so the decision is pre-computed the instant the
   * position crosses into liquidation — never executes on its own.
   */
  watch: boolean;
}

export type JevAction = "EXECUTE" | "QUEUE" | "SKIP";

export type ReasoningCode =
  | "high_ltv_low_competition_cascade_tail"
  | "low_edge_gas_risk"
  | "stale_oracle_skip"
  | "cascade_saturation"
  | "insufficient_seize_value"
  | "oracle_stale"
  | "borrower_too_young"
  | "ltv_spread_too_tight"
  | "margin_buffer_insufficient"
  | "max_concurrent_reached"
  | "data_inconsistent";

// Jev's plausibility verdict on the candidate's projected economics
export type SanityCode =
  | "plausible"
  | "seize_exceeds_collateral"
  | "ltv_hf_inconsistent"
  | "collateral_dust_mismatch"
  | "oracle_price_distortion";

export interface JevDecision {
  action: JevAction;
  confidence: number;           // TypeSafe confidence (0-1)
  actionProbabilities: Record<JevAction, number>; // full posterior
  reasoningCode: ReasoningCode;
  priority: number;             // 1 - 10
  sanity: SanityCode;
  sanityConfidence: number;     // 0 - 1
}

export interface ExecutionConfig {
  maxConcurrent: number;
  minSeizeUsd: number;
  minProfitForecastUsd: number;
  minJevConfidence: number;
  minJevSafety: number;
  marginBufferUsd: number;
  gasCostPctOfProfitMax: number;
  oracleDivergenceBps: number;
}

export interface OraclePrice {
  asset: string;
  priceUsd: number;
  updatedAt: number;
  source: "chainlink" | "pyth";
}

export interface ExecutionResult {
  success: boolean;
  txHash?: `0x${string}`;
  gasUsed?: bigint;
  gasCostUsd?: number;
  /** raw COLLATERAL wei seized (not USD — converting needs the collateral price) */
  seizedCollateralRaw?: bigint;
  slippageUsd?: number;
  profitUsd?: number;
  error?: string;
}

export interface ScanStats {
  candidatesFound: number;
  candidatesEvaluated: number;
  jevExecute: number;
  jevQueue: number;
  jevSkip: number;
  executed: number;
  reverted: number;
  failed: number;
  startTime: number;
}
