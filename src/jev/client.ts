import type { LiquidationCandidate, JevDecision, JevAction, ReasoningCode, SanityCode } from "../types.js";
import { gasCostUsd, projectedProfitUsd } from "../profit.js";

// ── TypeSafe/Jev API types ────────────────────────────────────────────────────

interface TypeSafeQuestion {
  type: "choice" | "score" | "noul";
  instructions: string | object | unknown[];
  criteria: Record<string, string | object | unknown[] | null> | Array<string | object | unknown[]>;
}

interface TypeSafeRequest {
  state: string | object | unknown[];
  model: string;
  questions: Record<string, TypeSafeQuestion>;
}

interface TypeSafeChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface TypeSafeScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

interface TypeSafeNoulAnswer {
  type: "noul";
  noul: number;
}

type TypeSafeAnswer = TypeSafeChoiceAnswer | TypeSafeScoreAnswer | TypeSafeNoulAnswer;

interface TypeSafeResponse {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Jev Client ────────────────────────────────────────────────────────────────

export interface JevClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface JevCallResult {
  decision: JevDecision;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
}

// State structure sent to Jev - all candidates in one batched call
function buildBatchState(candidates: LiquidationCandidate[]): object {
  const maxHfMismatchPct = Number(process.env.MAX_HF_MISMATCH_PCT ?? "0.30");
  return {
    candidates: candidates.map((c, i) => {
      const coll = c.collateralBalanceUsd;
      const borrow = c.borrowBalanceUsd;
      const impliedLtv = coll > 0 ? borrow / coll : null;
      const hfFromUsd = impliedLtv && impliedLtv > 0 ? c.liquidationThreshold / impliedLtv : null;
      const hf = c.healthFactor;
      const hfMismatchPct = hfFromUsd !== null && hf > 0
        ? Math.abs(hfFromUsd - hf) / hf
        : null;
      // The signals CONTRADICT each other only when they disagree on whether
      // the position is liquidatable (one side healthy, the other underwater).
      // Pure magnitude gaps (e.g. both < 1) are indexer/oracle-pricing
      // artifacts and must NOT be treated as inconsistent.
      const hfDirectionAgrees = hfFromUsd !== null && hf > 0
        ? (hfFromUsd > 1) === (hf > 1)
        : true;
      if (process.env.JEV_DEBUG === "1") {
        console.log(`  [jev-debug] ${c.borrower.slice(0,8)} hf=${hf?.toFixed(4)} hfFromUsd=${hfFromUsd?.toFixed(4)} mismatch=${(hfMismatchPct !== null ? hfMismatchPct * 100 : NaN).toFixed(1)}% dirAgree=${hfDirectionAgrees} lltv=${c.liquidationThreshold} coll=$${coll.toFixed(0)} borrow=$${borrow.toFixed(0)}`);
      }
      return {
        idx: i,
        protocol: c.protocol,
        borrower: c.borrower,
        collateralAsset: c.collateralAsset,
        collateralTier: c.collateralTier,
        borrowAsset: c.borrowAsset,
        currentLtv: c.currentLtv,
        liquidationThreshold: c.liquidationThreshold,
        ltvPastThresholdPct: (c.currentLtv - c.liquidationThreshold) * 100,
        reportedHealthFactor: hf,
        collateralUsd: coll,
        borrowUsd: borrow,
        seizePct: c.seizePct * 100,
        expectedSeizeUsd: c.expectedSeizeUsd,
        gasCostUsd: gasCostUsd(c),
        projectedProfitUsd: projectedProfitUsd(c),
        profitToSeizeRatio: c.expectedSeizeUsd > 0 ? projectedProfitUsd(c) / c.expectedSeizeUsd : null,
        oracleFreshnessSec: c.oracleFreshnessSec,
        gasPriceGwei: c.gasPriceGwei,
        estExecutionGas: c.estimatedExecutionGas,
        priceMove30mPct: c.recentPriceMovePct30m,
        cascadeScore: c.cascadeScore,
        competitionLast10Blocks: c.competitionLast10Blocks,
        ageBlocks: c.ageBlocks,
        sanity: {
          seizeToCollateralRatio: coll > 0 ? c.expectedSeizeUsd / coll : null,
          seizeExceedsCollateral: c.expectedSeizeUsd > coll,
          isDustCollateral: coll < 1 && borrow > 1,
          // NOTE: hfFromUsdBalances / hfMismatchPct / hfDirectionAgrees used to
          // live here but were removed — the classifier misread the HF pair and
          // flagged every row ltv_hf_inconsistent regardless of values. HF
          // consistency is now enforced deterministically in main.ts
          // (dataIntegrityGate) before candidates ever reach Jev.
        },
      };
    }),
    thresholds: {
      minSeizeUsd: Number(MIN_SEIZE_USD),
      minProfitUsd: Number(MIN_PROFIT_FORECAST_USD),
      maxGasPctOfProfit: MAX_GAS_PCT_OF_PROFIT,
      maxHfMismatchPct,
    },
  };
}

// Build per-candidate Choice question config
function makeCandidateQuestions(candidates: LiquidationCandidate[]): Record<string, TypeSafeQuestion> {
  const questions: Record<string, TypeSafeQuestion> = {};
  candidates.forEach((_, i) => {
    questions[`action_${i}`] = {
      type: "choice",
      instructions: ACTION_INSTRUCTIONS,
      criteria: ACTION_CRITERIA,
    };
    questions[`reasoning_${i}`] = {
      type: "choice",
      instructions: "What is the single primary reason for this decision? Pick the code that best matches the decisive factor from the checklist.",
      criteria: REASONING_CRITERIA,
    };
    questions[`priority_${i}`] = {
      type: "score",
      instructions: "Priority for execution if it were approved (1=lowest, 10=highest). Driven first by projectedProfitUsd, then by ltvPastThresholdPct, low competition, and liquid/known collateral. Low priority also when upside is marginal.",
      criteria: PRIORITY_CRITERIA,
    };
    questions[`sanity_${i}`] = {
      type: "choice",
      instructions: SANITY_INSTRUCTIONS,
      criteria: SANITY_CRITERIA,
    };
  });
  return questions;
}

const MIN_SEIZE_USD = process.env.MIN_SEIZE_USD ?? "500";
const MIN_PROFIT_FORECAST_USD = process.env.MIN_PROFIT_FORECAST_USD ?? "200";
const MARGIN_BUFFER_USD = process.env.MARGIN_BUFFER_USD ?? "2000";
const MAX_GAS_PCT_OF_PROFIT = Number(process.env.GAS_COST_PCT_OF_PROFIT_MAX ?? "0.40");

// ── Instructions ─────────────────────────────────────────────────────────────
// Tight, checklist-style: Jev is a fast structured classifier, not a reasoner
// that should invent its own standards. Every rule below maps to a field that
// is actually present in the state.

const ACTION_INSTRUCTIONS = [
  "Decide the fate of this candidate. Hard checks - ALL must pass for EXECUTE/QUEUE:",
  "1. DATA: HF was pre-verified upstream (consistent). SKIP if sanity.seizeExceedsCollateral or sanity.isDustCollateral (code data_inconsistent).",
  "2. PROFIT: projectedProfitUsd >= thresholds.minProfitUsd and gasCostUsd <= thresholds.maxGasPctOfProfit x projectedProfitUsd.",
  "3. SIZE: expectedSeizeUsd >= thresholds.minSeizeUsd.",
  "4. REALIZABILITY: seized collateral must be sellable for profit to be real. collateralTier: stable/bluechip/lrt saleable (EXECUTE-eligible); listed (USR, wbCOIN) = known venue, thin-but-real -> default QUEUE unless size is small enough to clear; long-tail (RSS, RLP, REIT, PT-*) = no verifiable market -> SKIP.",
  "5. FRESHNESS: oracleFreshnessSec fresh (morpho ~30s, ionic ~300s); priceMove30mPct large -> SKIP.",
  "EXECUTE only if ALL pass, numbers unambiguous, confidence high (~0.7+). QUEUE if all pass but one soft signal is marginal. Otherwise SKIP (including under uncertainty).",
].join("\n");

const ACTION_CRITERIA: Record<JevAction, string> = {
  EXECUTE: "All 5 hard checks pass, numbers unambiguous, confident (~0.7+).",
  QUEUE: "All 5 hard checks pass but one soft signal marginal (competition/oracle age/liquidity).",
  SKIP: "Any hard check fails, evidence ambiguous, or uncertain - dust, unsellable tail collateral, low profit, high gas, stale oracle.",
};

const REASONING_CRITERIA: Record<ReasoningCode, string> = {
  high_ltv_low_competition_cascade_tail: "Deeply past LTV threshold and little competition - attractive tail",
  low_edge_gas_risk: `Gas close to or above thresholds.maxGasPctOfProfit x profit, or very high gas price`,
  stale_oracle_skip: "Oracle freshness exceeds protocol tolerance (~30s morpho, ~300s ionic)",
  cascade_saturation: "competitionLast10Blocks >= 3 - market already contested",
  insufficient_seize_value: `expectedSeizeUsd below $${MIN_SEIZE_USD}`,
  oracle_stale: "Oracle stale or update failed",
  borrower_too_young: "Account too new (likely test or bot)",
  ltv_spread_too_tight: "Within ~2 points of the liquidation line - may recover",
  margin_buffer_insufficient: `Projected margin below $${MARGIN_BUFFER_USD} after gas and slippage`,
  max_concurrent_reached: "5 concurrent positions already open",
  data_inconsistent: "isDustCollateral or seizeExceedsCollateral - figures contradict (HF pre-verified upstream)",
};

const PRIORITY_CRITERIA = [
  "Very low priority - barely viable",
  "Low priority",
  "Below average priority",
  "Average priority",
  "Moderate priority",
  "Above average priority",
  "High priority",
  "Very high priority",
  "Critical priority",
  "Maximum priority - execute immediately",
];

const SANITY_CRITERIA: Record<SanityCode, string> = {
  plausible: "All sanity rules pass and figures are sane (profit <= seize, sensible profitToSeizeRatio)",
  seize_exceeds_collateral: "expectedSeizeUsd > collateralUsd - a liquidation can never seize more than is posted",
  ltv_hf_inconsistent: "Pre-verified upstream deterministically; do NOT select. Implausible collateral USD -> oracle_price_distortion instead.",
  collateral_dust_mismatch: "Near-zero collateral with material borrow (isDustCollateral) - pricing/decimals error",
  oracle_price_distortion: "Collateral USD implausible (stale/manipulated oracle or wrong decimals) - seized profit cannot be believed",
};

const SANITY_INSTRUCTIONS = [
  "Check whether the projected economics are internally consistent and physically possible on-chain:",
  "1. sanity.seizeExceedsCollateral true -> seize_exceeds_collateral.",
  "2. HF was pre-verified deterministically upstream; do NOT use ltv_hf_inconsistent. Oracle-priced exotic collateral whose USD value looks implausible -> oracle_price_distortion.",
  "3. sanity.isDustCollateral true -> collateral_dust_mismatch.",
  "4. plausible only if all above pass and figures hang together (profitToSeizeRatio sane, profit <= seize).",
  "When torn, choose the failure code: wrong-block costs nothing, wrong-go costs real money.",
].join("\n");

const QUESTIONS: Record<string, TypeSafeQuestion> = {
  action: {
    type: "choice",
    instructions: ACTION_INSTRUCTIONS,
    criteria: ACTION_CRITERIA,
  },
  reasoningCode: {
    type: "choice",
    instructions: "What is the single primary reason for this decision? Pick the code that best matches the decisive factor from the checklist.",
    criteria: REASONING_CRITERIA,
  },
  priority: {
    type: "score",
    instructions: "Priority for execution if it were approved (1=lowest, 10=highest). Driven first by projectedProfitUsd, then by ltvPastThresholdPct, low competition, and liquid/known collateral. Low priority also when upside is marginal.",
    criteria: PRIORITY_CRITERIA,
  },
  sanity: {
    type: "choice",
    instructions: SANITY_INSTRUCTIONS,
    criteria: SANITY_CRITERIA,
  },
};

export class JevClient {
  private config: JevClientConfig;
  private totalCostUsd = 0;
  private totalCalls = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;

  constructor(config: JevClientConfig) {
    this.config = config;
  }

  // Evaluate a batch of candidates in a single API call
  async evaluateBatch(candidates: LiquidationCandidate[]): Promise<JevDecision[]> {
    if (candidates.length === 0) return [];

    const start = Date.now();

    const request: TypeSafeRequest = {
      state: buildBatchState(candidates),
      model: this.config.model,
      questions: makeCandidateQuestions(candidates),
    };

    const res = await fetch(`${this.config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TypeSafe API ${res.status}: ${err}`);
    }

    const data = await res.json() as TypeSafeResponse;
    const latencyMs = Date.now() - start;

    // Parse all candidate decisions
    const decisions: JevDecision[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const actionAnswer = data.answers[`action_${i}`] as TypeSafeChoiceAnswer;
      const reasoningAnswer = data.answers[`reasoning_${i}`] as TypeSafeChoiceAnswer;
      const priorityAnswer = data.answers[`priority_${i}`] as TypeSafeScoreAnswer;
      const sanityAnswer = data.answers[`sanity_${i}`] as TypeSafeChoiceAnswer;

      if (!actionAnswer || actionAnswer.type !== "choice") {
        throw new Error(`Missing or invalid action answer for candidate ${i}`);
      }
      if (!reasoningAnswer || reasoningAnswer.type !== "choice") {
        throw new Error(`Missing or invalid reasoningCode answer for candidate ${i}`);
      }
      if (!priorityAnswer || priorityAnswer.type !== "score") {
        throw new Error(`Missing or invalid priority answer for candidate ${i}`);
      }
      if (!sanityAnswer || sanityAnswer.type !== "choice") {
        throw new Error(`Missing or invalid sanity answer for candidate ${i}`);
      }

      const action = actionAnswer.choice as JevAction;
      const confidence = actionAnswer.confidence;
      const actionProbabilities = actionAnswer.probabilities as Record<JevAction, number>;
      const reasoningCode = reasoningAnswer.choice as ReasoningCode;
      const priority = Math.round(Math.min(10, Math.max(1, priorityAnswer.score)));
      const sanity = sanityAnswer.choice as SanityCode;

      if (action === "EXECUTE") {
        console.log(`  [jev] EXECUTE p=${confidence.toFixed(2)} probs=${JSON.stringify(actionProbabilities)} (${candidates[i].borrower.slice(0,8)})`);
      }

      decisions.push({
        action,
        confidence,
        actionProbabilities,
        reasoningCode,
        priority,
        sanity,
        sanityConfidence: sanityAnswer.confidence,
      });
    }

    // Usage tracking — tokens are the real billable metric we can read from
    // the API (data.usage). The USD figure below is an ESTIMATE based on the
    // published $0.042/M input-token rate, kept as a rough reference only.
    const tokensIn = data.usage.input_tokens;
    const tokensOut = data.usage.output_tokens;
    const costUsd = tokensIn * 0.000000042; // $0.042/M (estimate)
    this.totalCostUsd += costUsd;
    this.totalCalls++;
    this.totalTokensIn += tokensIn;
    this.totalTokensOut += tokensOut;

    return decisions;
  }

  // Keep for backward compat (unused after batching)
  async evaluate(candidate: LiquidationCandidate): Promise<JevCallResult> {
    const decisions = await this.evaluateBatch([candidate]);
    return { decision: decisions[0], tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0 };
  }

  getStats() {
    return {
      totalCalls: this.totalCalls,
      totalCostUsd: this.totalCostUsd, // ESTIMATE only (see above)
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
    };
  }
}

export function createJevClientFromEnv(): JevClient {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY not set");

  return new JevClient({
    apiKey,
    model: process.env.JEV_MODEL ?? "jev-latest",
    baseUrl: "https://api.typesafe.ai",
  });
}