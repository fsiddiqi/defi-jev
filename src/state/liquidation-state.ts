export interface LiquidationState {
  collateral_asset: string;
  collateral_amount: string;
  collateral_price_usd: string;
  collateral_usd_value: string;
  debt_asset: string;
  debt_amount: string;
  debt_price_usd: string;
  debt_usd_value: string;
  ltv_current: number;
  ltv_liquidation_threshold: number;
  ltv_close_factor: number;
  gas_price_gwei: number;
  gas_estimate_units: number;
  liquidation_bonus: number;
  profit_usd: number;
  profit_after_gas: number;
  user_address: string;
  protocol: string;
  timestamp: number;
}

export function generateMockLiquidationState(
  overrides: Partial<LiquidationState> = {}
): LiquidationState {
  const gasPriceGwei = 45 + Math.random() * 30;
  const gasEstimate = 550000;
  const gasSpendUsd = (gasPriceGwei * gasEstimate * 3000) / 1e9;

  const collateralAmount = '100000000000000000000';
  const collateralPrice = '2500';
  const collateralUsdValue = 250000;

  const debtAmount = '200000000000';
  const debtPrice = '1';
  const debtUsdValue = 200000;

  const ltvCurrent = 0.75 + Math.random() * 0.12;
  const ltvThreshold = 0.85;
  const ltvCloseFactor = 0.5;

  const bonus = 0.08;
  const bonusValue = debtUsdValue * bonus;

  const grossProfit = bonusValue;
  const netProfit = Math.max(0, grossProfit - gasSpendUsd);

  return {
    collateral_asset: 'WETH',
    collateral_amount: collateralAmount,
    collateral_price_usd: collateralPrice,
    collateral_usd_value: collateralUsdValue.toString(),
    debt_asset: 'USDC',
    debt_amount: debtAmount,
    debt_price_usd: debtPrice,
    debt_usd_value: debtUsdValue.toString(),
    ltv_current: ltvCurrent,
    ltv_liquidation_threshold: ltvThreshold,
    ltv_close_factor: ltvCloseFactor,
    gas_price_gwei: gasPriceGwei,
    gas_estimate_units: gasEstimate,
    liquidation_bonus: bonus,
    profit_usd: grossProfit,
    profit_after_gas: netProfit,
    user_address: '0x' + 'abc123'.repeat(7),
    protocol: 'aave',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function generateMockLiquidationBatch(
  count: number = 5
): LiquidationState[] {
  return Array.from({ length: count }, (_, i) => {
    const urgencyLevel = (i / count) * 0.15;
    return generateMockLiquidationState({
      ltv_current: 0.75 + urgencyLevel,
      user_address: '0x' + i.toString().padStart(40, 'a'),
    });
  });
}

export function formatState(state: LiquidationState): string {
  return `
[${state.protocol.toUpperCase()}] ${state.user_address.slice(0, 10)}...
├─ Collateral: ${parseFloat(state.collateral_amount) / 1e18} ${state.collateral_asset} = $${state.collateral_usd_value}
├─ Debt: ${parseFloat(state.debt_amount) / 1e6} ${state.debt_asset} = $${state.debt_usd_value}
├─ LTV: ${(state.ltv_current * 100).toFixed(1)}% (threshold: ${(state.ltv_liquidation_threshold * 100).toFixed(1)}%)
├─ Gas: ${state.gas_price_gwei.toFixed(1)} gwei → ~$${((state.gas_price_gwei * state.gas_estimate_units * 3000) / 1e9).toFixed(0)}
└─ Profit: $${state.profit_after_gas.toFixed(2)} (bonus: ${(state.liquidation_bonus * 100).toFixed(1)}%)
  `;
}
