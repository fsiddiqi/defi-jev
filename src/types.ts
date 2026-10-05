// Shared types for the liquidation racing CLI

export type Protocol = "morpho-blue" | "ionic";

export type AssetTier = "stable" | "bluechip" | "lrt" | "long-tail";

export interface LiquidationCandidate {
  protocol: Protocol;
  borrower: `0x${string}`;
  collateralAsset: string;
  borrowAsset: string;
  currentLtv: number;
  liquidationThreshold: number;
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
  | "max_concurrent_reached";

export interface JevDecision {
  action: JevAction;
  confidence: number;        // 0.0 - 1.0
  reasoningCode: ReasoningCode;
  priority: number;          // 1 - 10
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
  collateralSeizedUsd?: number;
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
