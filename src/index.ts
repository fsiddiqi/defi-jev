import 'dotenv/config';
import { logger } from '@/logging';
import {
  generateMockLiquidationBatch,
  formatState,
} from '@/state/liquidation-state';
import { askJev, askJevMock } from '@/jev/classifier';
import { checkRiskGates, logGateCheckResult } from '@/execution/risk-gates';
import { paperExecutor } from '@/execution/paper';
import {
  emitStateGenerated,
  emitJevDecision,
  emitGatesChecked,
  emitLiquidationExecuted,
  emitSessionStats,
} from '@/server/events';
import { initDashboard } from '@/server/dashboard';
import { initTelegram, alertSessionStart, alertSessionEnd, alertLiquidation, alertSkipped, alertError } from '@/server/telegram';

async function main() {
  const isDryRun = process.env.DRY_RUN === 'true';
  const useMockJev = !process.env.TYPESAFE_API_KEY;

  // Initialize dashboard (SSE + HTML on port 3000)
  initDashboard(3000);
  
  // Initialize Telegram alerts
  const telegramEnabled = await initTelegram();

  logger.info(`\n🤖 DeFi Jev Bot Starting`);
  logger.info(`📍 Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  logger.info(`🧠 Jev: ${useMockJev ? 'MOCK (no API key)' : 'REAL'}`);
  logger.info(`📊 Dashboard: http://localhost:3000`);
  logger.info(`📱 Telegram: ${telegramEnabled ? 'enabled' : 'disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
  logger.info(`\n---\n`);

  if (telegramEnabled) {
    await alertSessionStart(isDryRun ? 'DRY RUN' : 'LIVE', useMockJev ? 'MOCK' : 'REAL');
  }

  const opportunities = generateMockLiquidationBatch(5);

  logger.info(`📊 Generated ${opportunities.length} mock liquidation opportunities\n`);

  for (const state of opportunities) {
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`Evaluating: ${state.user_address.slice(0, 10)}...`);
    logger.info(`${'='.repeat(60)}`);

    emitStateGenerated(state);
    logger.info(formatState(state));

    const jeyDecision = useMockJev
      ? await askJevMock(state)
      : await askJev(state);

    emitJevDecision(jeyDecision, state.user_address);

    const gateResult = checkRiskGates(jeyDecision, state);
    logGateCheckResult(gateResult);
    emitGatesChecked(gateResult);

    if (gateResult.should_execute) {
      try {
        const fill = await paperExecutor.execute(state);
        emitLiquidationExecuted(state, jeyDecision, state.profit_after_gas);
        if (telegramEnabled) {
          await alertLiquidation(fill, jeyDecision, paperExecutor.getStats());
        }
      } catch (error) {
        logger.error('❌ Execution failed:', error);
        if (telegramEnabled) {
          await alertError('execution', error as Error);
        }
      }
    } else {
      logger.info(`⏭️  Skipped: ${gateResult.reason}\n`);
      if (telegramEnabled) {
        await alertSkipped(state, gateResult.reason);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const stats = paperExecutor.getStats();
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`📈 Session Summary`);
  logger.info(`${'='.repeat(60)}`);
  logger.info(`Total liquidations: ${stats.count}`);
  logger.info(`Total gas spent: $${stats.total_gas_usd.toFixed(2)}`);
  logger.info(`Total profit: $${stats.total_profit_usd.toFixed(2)}`);
  if (stats.count > 0) {
    logger.info(
      `Avg profit per liquidation: $${stats.average_profit_per_liquidation.toFixed(2)}`
    );
  }
  logger.info(`\n✅ Bot completed!\n`);

  emitSessionStats(stats);
  
  if (telegramEnabled) {
    await alertSessionEnd(stats);
  }
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
