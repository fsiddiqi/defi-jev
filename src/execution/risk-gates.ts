import { logger } from '@/logging';
import { JevDecision } from '@/jev/classifier';
import { LiquidationState } from '@/state/liquidation-state';

export interface RiskGateConfig {
  min_urgency: number;
  min_profitability: number;
  min_safety_score: number;
  max_gas_usd: number;
  min_profit_usd: number;
  max_ltv_loss: number;
  max_daily_liquidations: number;
  max_concurrent_liquidations: number;
}

export const DEFAULT_RISK_GATES: RiskGateConfig = {
  min_urgency: 0.6,
  min_profitability: 25,
  min_safety_score: 0.7,
  max_gas_usd: 200,
  min_profit_usd: 10,
  max_ltv_loss: 0.1,
  max_daily_liquidations: 100,
  max_concurrent_liquidations: 1,
};

export interface GateCheckResult {
  should_execute: boolean;
  passed_gates: string[];
  failed_gates: string[];
  reason: string;
  jev_decision: JevDecision;
  state: LiquidationState;
}

export function checkRiskGates(
  jeyDecision: JevDecision,
  state: LiquidationState,
  config: RiskGateConfig = DEFAULT_RISK_GATES
): GateCheckResult {
  const passed_gates: string[] = [];
  const failed_gates: string[] = [];

  if (jeyDecision.urgency >= config.min_urgency) {
    passed_gates.push(`urgency (${(jeyDecision.urgency * 100).toFixed(1)}% >= ${(config.min_urgency * 100).toFixed(1)}%)`);
  } else {
    failed_gates.push(`urgency (${(jeyDecision.urgency * 100).toFixed(1)}% < ${(config.min_urgency * 100).toFixed(1)}%)`);
  }

  if (jeyDecision.profitability >= config.min_profitability) {
    passed_gates.push(`profitability ($${jeyDecision.profitability.toFixed(0)} >= $${config.min_profitability})`);
  } else {
    failed_gates.push(`profitability ($${jeyDecision.profitability.toFixed(0)} < $${config.min_profitability})`);
  }

  if (jeyDecision.is_safe >= config.min_safety_score) {
    passed_gates.push(`safety (${(jeyDecision.is_safe * 100).toFixed(1)}% >= ${(config.min_safety_score * 100).toFixed(1)}%)`);
  } else {
    failed_gates.push(`safety (${(jeyDecision.is_safe * 100).toFixed(1)}% < ${(config.min_safety_score * 100).toFixed(1)}%)`);
  }

  const gasSpendUsd = (state.gas_price_gwei * state.gas_estimate_units * 3000) / 1e9;
  if (gasSpendUsd <= config.max_gas_usd) {
    passed_gates.push(`gas cost ($${gasSpendUsd.toFixed(2)} <= $${config.max_gas_usd})`);
  } else {
    failed_gates.push(`gas cost ($${gasSpendUsd.toFixed(2)} > $${config.max_gas_usd})`);
  }

  if (state.profit_after_gas >= config.min_profit_usd) {
    passed_gates.push(`min profit ($${state.profit_after_gas.toFixed(2)} >= $${config.min_profit_usd})`);
  } else {
    failed_gates.push(`min profit ($${state.profit_after_gas.toFixed(2)} < $${config.min_profit_usd})`);
  }

  const ltvImprovement = state.ltv_close_factor * (state.profit_usd / parseFloat(state.debt_usd_value));
  if (ltvImprovement <= config.max_ltv_loss) {
    passed_gates.push(`ltv improvement (acceptable)`);
  } else {
    failed_gates.push(`ltv improvement (liquidation would not help enough)`);
  }

  const should_execute = failed_gates.length === 0;
  const reason = should_execute
    ? `✅ All gates passed`
    : `❌ Failed gates: ${failed_gates.join(', ')}`;

  return {
    should_execute,
    passed_gates,
    failed_gates,
    reason,
    jev_decision: jeyDecision,
    state,
  };
}

export function logGateCheckResult(result: GateCheckResult): void {
  logger.info(`\n🚪 Risk Gate Check:\n`);
  logger.info(`   Passed: ${result.passed_gates.join(', ') || 'none'}`);
  if (result.failed_gates.length > 0) {
    logger.warn(`   Failed: ${result.failed_gates.join(', ')}`);
  }
  logger.info(`\n   ${result.reason}\n`);
  if (result.should_execute) {
    logger.info(`🚀 Ready to execute liquidation!\n`);
  }
}
