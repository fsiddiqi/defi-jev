import { z } from "zod";
import type { LiquidationCandidate, JevDecision, JevAction, ReasoningCode } from "../types.js";

// ── Zod schema for Jev output ────────────────────────────────────────────────

const JevActionSchema = z.enum(["EXECUTE", "QUEUE", "SKIP"]);

const ReasoningCodeSchema = z.enum([
  "high_ltv_low_competition_cascade_tail",
  "low_edge_gas_risk",
  "stale_oracle_skip",
  "cascade_saturation",
  "insufficient_seize_value",
  "oracle_stale",
  "borrower_too_young",
  "ltv_spread_too_tight",
  "margin_buffer_insufficient",
  "max_concurrent_reached",
]);

const JevDecisionSchema = z.object({
  action: JevActionSchema,
  confidence: z.number().min(0).max(1),
  reasoningCode: ReasoningCodeSchema,
  priority: z.number().int().min(1).max(10),
});

export type JevDecisionParsed = z.infer<typeof JevDecisionSchema>;

// ── OpenRouter client ────────────────────────────────────────────────────────

interface OpenRouterMessage {
  role: "system" | "user";
  content: string;
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature: number;
  max_tokens: number;
  response_format?: { type: "json_object" };
}

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface JevClientConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  baseUrl: string;
}

export interface JevCallResult {
  decision: JevDecisionParsed;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
}

const SYSTEM_PROMPT = `You are a liquidation racing judge for Base (Morpho Blue + Ionic).
You receive ONE abandoned liquidation candidate at a time (200+ blocks since liquidatable).
Your job: judge if the flash-loan execution is worth the gas and risk.

CONTEXT:
- Execution is ATOMIC: flash loan → liquidate → seize → unwrap/swap → repay in ONE transaction.
- No position holding, no inventory risk. Profit = seize value - gas - slippage.
- Flash loan provider: Balancer Vault. Swap: Uniswap V3.
- Slippage assumption: 50 bps. Gas base: $0.50 + scaling.
- Risk premiums by tier: stable $0.50, bluechip $1.00, LRT $3.00, long-tail $5.00.
- Protocol margin modifiers: ionic 1.0x, morpho-blue 1.2x.

OUTPUT: JSON only. Schema:
{
  "action": "EXECUTE" | "QUEUE" | "SKIP",
  "confidence": 0.0-1.0,
  "reasoning_code": "high_ltv_low_competition_cascade_tail" | "low_edge_gas_risk" | "stale_oracle_skip" | "cascade_saturation" | "insufficient_seize_value" | "oracle_stale" | "borrower_too_young" | "ltv_spread_too_tight" | "margin_buffer_insufficient" | "max_concurrent_reached",
  "priority": 1-10
}

REASONING CODE MEANINGS:
- high_ltv_low_competition_cascade_tail: LTV > 0.92, few competitors, cascade score > 0.5
- low_edge_gas_risk: expected profit < 2x gas, or gas > 100 gwei
- stale_oracle_skip: oracle freshness > 30s (morpho) or > 300s (ionic)
- cascade_saturation: 3+ liquidations in last 5 blocks, cascade score > 0.7
- insufficient_seize_value: expected seize < $500
- oracle_stale: oracle update failed or > threshold
- borrower_too_young: account age < 3 days (likely test/bot)
- ltv_spread_too_tight: current LTV within 2% of threshold
- margin_buffer_insufficient: available margin < $1,000
- max_concurrent_reached: 5 concurrent positions already open

DECISION LOGIC:
- EXECUTE: high confidence (>0.7), clear edge, all gates pass
- QUEUE: moderate confidence (0.55-0.7), or one soft gate marginal
- SKIP: low confidence (<0.55), any hard gate fails, or forecast profit < $200

Be conservative. False positives cost gas. False negatives cost opportunity — but opportunity is infinite.`;

function buildUserPrompt(candidate: LiquidationCandidate): string {
  return `CANDIDATE:
protocol: ${candidate.protocol}
borrower: ${candidate.borrower}
collateral: ${candidate.collateralAsset}
borrow: ${candidate.borrowAsset}
current_ltv: ${candidate.currentLtv.toFixed(4)}
liquidation_threshold: ${candidate.liquidationThreshold.toFixed(4)}
ltv_gap_pct: ${((candidate.liquidationThreshold - candidate.currentLtv) * 100).toFixed(2)}%
collateral_usd: ${candidate.collateralBalanceUsd.toFixed(2)}
borrow_usd: ${candidate.borrowBalanceUsd.toFixed(2)}
seize_pct: ${(candidate.seizePct * 100).toFixed(2)}%
expected_seize_usd: ${candidate.expectedSeizeUsd.toFixed(2)}
oracle_freshness_sec: ${candidate.oracleFreshnessSec.toFixed(1)}
gas_price_gwei: ${candidate.gasPriceGwei}
est_execution_gas: ${candidate.estimatedExecutionGas.toLocaleString()}
price_move_30m_pct: ${candidate.recentPriceMovePct30m.toFixed(2)}
cascade_score: ${candidate.cascadeScore.toFixed(2)}
competition_10_blocks: ${candidate.competitionLast10Blocks}
age_blocks: ${candidate.ageBlocks}

OUTPUT JSON ONLY.`;
}

export class JevClient {
  private config: JevClientConfig;
  private totalCostUsd = 0;
  private totalCalls = 0;

  constructor(config: JevClientConfig) {
    this.config = config;
  }

  async evaluate(candidate: LiquidationCandidate): Promise<JevCallResult> {
    const start = Date.now();

    const request: OpenRouterRequest = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(candidate) },
      ],
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      response_format: { type: "json_object" },
    };

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/fsiddiqi/defi-jev",
        "X-Title": "defi-jev liquidation racing",
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${err}`);
    }

    const data = await res.json() as OpenRouterResponse;
    const latencyMs = Date.now() - start;

    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from Jev");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Jev returned invalid JSON: ${content.slice(0, 200)}`);
    }

    const validated = JevDecisionSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Jev output failed schema: ${validated.error.message}`);
    }

    // Cost tracking (OpenRouter pricing varies by model; assume $0.06/M in/out for now)
    const tokensIn = data.usage.prompt_tokens;
    const tokensOut = data.usage.completion_tokens;
    const costUsd = (tokensIn + tokensOut) * 0.00000006; // $0.06/M

    this.totalCostUsd += costUsd;
    this.totalCalls++;

    return {
      decision: validated.data,
      tokensIn,
      tokensOut,
      latencyMs,
      costUsd,
    };
  }

  getStats() {
    return { totalCalls: this.totalCalls, totalCostUsd: this.totalCostUsd };
  }
}

export function createJevClientFromEnv(): JevClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  return new JevClient({
    apiKey,
    model: process.env.JEV_MODEL ?? "typesafe/jev",
    temperature: Number(process.env.JEV_TEMPERATURE ?? "0.1"),
    maxTokens: Number(process.env.JEV_MAX_TOKENS ?? "500"),
    baseUrl: "https://openrouter.ai/api/v1",
  });
}
