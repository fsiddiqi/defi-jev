import { logger } from '@/logging';
import { LiquidationState } from '@/state/liquidation-state';

export interface PaperFill {
  timestamp: number;
  user_address: string;
  collateral_asset: string;
  debt_asset: string;
  debt_closed_usd: number;
  gas_spent_usd: number;
  profit_usd: number;
  status: 'executed' | 'simulated';
}

export class PaperExecutor {
  private fills: PaperFill[] = [];
  private cumulative_gas: number = 0;
  private cumulative_profit: number = 0;

  async execute(state: LiquidationState): Promise<PaperFill> {
    const gasSpendUsd = (state.gas_price_gwei * state.gas_estimate_units * 3000) / 1e9;
    const debtClosedUsd = parseFloat(state.debt_usd_value) * state.ltv_close_factor;

    const fill: PaperFill = {
      timestamp: Date.now(),
      user_address: state.user_address,
      collateral_asset: state.collateral_asset,
      debt_asset: state.debt_asset,
      debt_closed_usd: debtClosedUsd,
      gas_spent_usd: gasSpendUsd,
      profit_usd: state.profit_after_gas,
      status: 'simulated',
    };

    this.fills.push(fill);
    this.cumulative_gas += gasSpendUsd;
    this.cumulative_profit += state.profit_after_gas;

    logger.info(`\n💰 [PAPER] Liquidation executed (simulated):`);
    logger.info(`   Closed: $${debtClosedUsd.toFixed(2)} ${state.debt_asset}`);
    logger.info(`   Gas: $${gasSpendUsd.toFixed(2)}`);
    logger.info(`   Profit: $${state.profit_after_gas.toFixed(2)}`);
    logger.info(`\n   Cumulative (this session):`);
    logger.info(`   Total Gas Spent: $${this.cumulative_gas.toFixed(2)}`);
    logger.info(`   Total Profit: $${this.cumulative_profit.toFixed(2)}`);

    return fill;
  }

  getFills(): PaperFill[] {
    return this.fills;
  }

  getStats(): {
    count: number;
    total_gas_usd: number;
    total_profit_usd: number;
    average_profit_per_liquidation: number;
  } {
    return {
      count: this.fills.length,
      total_gas_usd: this.cumulative_gas,
      total_profit_usd: this.cumulative_profit,
      average_profit_per_liquidation:
        this.fills.length > 0 ? this.cumulative_profit / this.fills.length : 0,
    };
  }

  reset(): void {
    this.fills = [];
    this.cumulative_gas = 0;
    this.cumulative_profit = 0;
  }
}

export const paperExecutor = new PaperExecutor();
