import { describe, it, expect } from 'vitest';
import {
  generateMockLiquidationState,
  generateMockLiquidationBatch,
  formatState,
} from '@/state/liquidation-state';

describe('LiquidationState', () => {
  it('should generate a valid mock state', () => {
    const state = generateMockLiquidationState();

    expect(state.collateral_asset).toBe('WETH');
    expect(state.debt_asset).toBe('USDC');
    expect(state.ltv_current).toBeGreaterThan(0);
    expect(state.ltv_current).toBeLessThan(1);
    expect(state.protocol).toBe('aave');
    expect(state.timestamp).toBeGreaterThan(0);
  });

  it('should calculate profit correctly', () => {
    const state = generateMockLiquidationState();
    expect(state.profit_after_gas).toBeLessThanOrEqual(state.profit_usd);
  });

  it('should apply overrides', () => {
    const override = { collateral_asset: 'DAI', ltv_current: 0.9 };
    const state = generateMockLiquidationState(override);

    expect(state.collateral_asset).toBe('DAI');
    expect(state.ltv_current).toBe(0.9);
  });

  it('should generate a batch of states', () => {
    const batch = generateMockLiquidationBatch(10);

    expect(batch).toHaveLength(10);
    expect(batch[0].ltv_current).toBeLessThan(batch[batch.length - 1].ltv_current);
  });

  it('should format state to string', () => {
    const state = generateMockLiquidationState();
    const formatted = formatState(state);

    expect(formatted).toContain('WETH');
    expect(formatted).toContain('USDC');
    expect(formatted).toContain('LTV');
  });
});
