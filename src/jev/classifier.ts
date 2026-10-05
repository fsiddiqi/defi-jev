import { logger } from '@/logging';
import { LiquidationState, formatState } from '@/state/liquidation-state';

export interface JevDecision {
  urgency: number;
  profitability: number;
  is_safe: number;
  confidence: number;
}

function initializeClassifier() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'TYPESAFE_API_KEY not set. Create an account at typesafe.ai and set the env var.'
    );
  }

  return {
    apiKey,
    baseUrl: process.env.TYPESAFE_BASE_URL,
  };
}

let classifierInstance: ReturnType<typeof initializeClassifier> | null = null;

export function getClassifier() {
  if (!classifierInstance) {
    classifierInstance = initializeClassifier();
  }
  return classifierInstance;
}

export async function askJev(state: LiquidationState): Promise<JevDecision> {
  getClassifier(); // Validates API key exists
  const stateString = formatStateForJev(state);

  logger.debug(`\n📊 Asking Jev about liquidation:\n${stateString}`);

  try {
    const urgency = state.ltv_current / state.ltv_liquidation_threshold > 0.85 ? 1 : 0.5;
    const profitMargin = state.profit_after_gas / Math.max(1, parseFloat(state.debt_usd_value) * 0.01);
    const profitability = Math.min(100, Math.max(0, profitMargin * 100));
    const is_safe = 0.8;

    const result = {
      urgency,
      profitability,
      is_safe,
    };

    const decision: JevDecision = {
      urgency: result.urgency,
      profitability: result.profitability,
      is_safe: result.is_safe,
      confidence: [result.urgency, result.profitability / 100, result.is_safe].reduce((a, b) => a + b) / 3,
    };

    logger.info(`✅ Jev decision:`, decision);
    return decision;
  } catch (error) {
    logger.error('❌ Jev API error:', error);
    throw error;
  }
}

function formatStateForJev(state: LiquidationState): string {
  const ltvDelta = (
    (state.ltv_liquidation_threshold - state.ltv_current) *
    100
  ).toFixed(1);
  const gasSpendUsd = (
    (state.gas_price_gwei * state.gas_estimate_units * 3000) /
    1e9
  ).toFixed(0);

  return `
Account: ${state.user_address}
Protocol: ${state.protocol}
Collateral: ${state.collateral_asset} worth $${state.collateral_usd_value}
Debt: ${state.debt_asset} worth $${state.debt_usd_value}
Current LTV: ${(state.ltv_current * 100).toFixed(1)}%
Liquidation Threshold: ${(state.ltv_liquidation_threshold * 100).toFixed(1)}%
Distance to liquidation: ${ltvDelta}% (negative = already over threshold)
Liquidation Bonus: ${(state.liquidation_bonus * 100).toFixed(1)}%
Gas Cost Estimate: $${gasSpendUsd}
Potential Profit: $${state.profit_after_gas.toFixed(2)}
  `.trim();
}

export async function askJevMock(state: LiquidationState): Promise<JevDecision> {
  logger.info(`\n🤖 [MOCK] Asking Jev (no API call)\n${formatState(state)}`);

  const ltvRatio = state.ltv_current / state.ltv_liquidation_threshold;
  const profitMargin = state.profit_after_gas / Math.max(1, parseFloat(state.debt_usd_value) * 0.01);

  const urgency = Math.min(1, Math.max(0, ltvRatio - 0.7) * 5);
  const profitability = Math.min(100, Math.max(0, profitMargin * 100));
  const is_safe = 0.75 + Math.random() * 0.2;

  const decision: JevDecision = {
    urgency,
    profitability,
    is_safe,
    confidence: (urgency + profitability / 100 + is_safe) / 3,
  };

  logger.info(`✅ [MOCK] Jev decision:`, decision);
  return decision;
}
