import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRiskGates,
  DEFAULT_RISK_GATES,
  RiskGateConfig,
} from '@/execution/risk-gates';
import { generateMockLiquidationState } from '@/state/liquidation-state';
import { JevDecision } from '@/jev/classifier';
import { PaperExecutor } from '@/execution/paper';

describe('Risk Gates', () => {
  const mockState = generateMockLiquidationState();
  const mockDecision: JevDecision = {
    urgency: 0.8,
    profitability: 60,
    is_safe: 0.85,
    confidence: 0.75,
  };

  it('should pass all gates with high scores', () => {
    const result = checkRiskGates(mockDecision, mockState);

    expect(result.should_execute).toBe(true);
    expect(result.failed_gates.length).toBe(0);
  });

  it('should fail on low urgency', () => {
    const lowUrgency: JevDecision = { ...mockDecision, urgency: 0.1 };
    const result = checkRiskGates(lowUrgency, mockState);

    expect(result.should_execute).toBe(false);
    expect(result.failed_gates.some((g) => g.includes('urgency'))).toBe(true);
  });

  it('should fail on low profitability', () => {
    const lowProfit: JevDecision = { ...mockDecision, profitability: 5 };
    const result = checkRiskGates(lowProfit, mockState);

    expect(result.should_execute).toBe(false);
    expect(result.failed_gates.some((g) => g.includes('profitability'))).toBe(true);
  });

  it('should fail on low safety', () => {
    const lowSafety: JevDecision = { ...mockDecision, is_safe: 0.2 };
    const result = checkRiskGates(lowSafety, mockState);

    expect(result.should_execute).toBe(false);
    expect(result.failed_gates.some((g) => g.includes('safety'))).toBe(true);
  });

  it('should respect custom gate config', () => {
    const strictConfig: RiskGateConfig = {
      ...DEFAULT_RISK_GATES,
      min_urgency: 0.99,
    };
    const result = checkRiskGates(mockDecision, mockState, strictConfig);

    expect(result.should_execute).toBe(false);
  });
});

describe('PaperExecutor', () => {
  let executor: PaperExecutor;

  beforeEach(() => {
    executor = new PaperExecutor();
  });

  it('should execute a paper trade', async () => {
    const state = generateMockLiquidationState();
    const fill = await executor.execute(state);

    expect(fill.status).toBe('simulated');
    expect(fill.profit_usd).toBeGreaterThanOrEqual(0);
  });

  it('should track fills', async () => {
    const state1 = generateMockLiquidationState();
    const state2 = generateMockLiquidationState();

    await executor.execute(state1);
    await executor.execute(state2);

    const fills = executor.getFills();
    expect(fills).toHaveLength(2);
  });

  it('should accumulate stats', async () => {
    const state = generateMockLiquidationState({
      profit_after_gas: 100,
    });

    await executor.execute(state);

    const stats = executor.getStats();
    expect(stats.count).toBe(1);
    expect(stats.total_profit_usd).toBeGreaterThan(0);
  });

  it('should reset state', async () => {
    const state = generateMockLiquidationState();
    await executor.execute(state);

    executor.reset();

    const stats = executor.getStats();
    expect(stats.count).toBe(0);
    expect(stats.total_profit_usd).toBe(0);
  });
});
