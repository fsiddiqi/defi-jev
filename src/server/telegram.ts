import { logger } from '@/logging';
import { PaperFill } from '@/execution/paper';
import { JevDecision } from '@/jev/classifier';
import { LiquidationState } from '@/state/liquidation-state';

let bot: any = null;
let chatId: string | null = null;

export function initTelegram(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !id) {
    logger.warn('Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return false;
  }
  
  try {
    // Dynamic import to avoid requiring telegraf if not configured
    const { Telegraf } = require('telegraf');
    bot = new Telegraf(token);
    chatId = id;
    logger.info('✅ Telegram alerts enabled');
    return true;
  } catch (e) {
    logger.warn('Telegram init failed (telegraf not installed?):', e);
    return false;
  }
}

async function send(msg: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  } catch (e) {
    logger.error('Telegram send failed:', e);
  }
}

export async function alertLiquidation(
  fill: PaperFill,
  decision: JevDecision,
  stats: { total_profit_usd: number; total_gas_usd: number; count: number }
): Promise<void> {
  const emoji = fill.profit_usd > 0 ? '🟢' : '🔴';
  await send(
    `${emoji} <b>Liquidation Executed</b>\n` +
    `Account: <code>${fill.user_address.slice(0, 10)}...</code>\n` +
    `Pair: ${fill.collateral_asset}/${fill.debt_asset}\n` +
    `Closed: $${fill.debt_closed_usd.toFixed(2)}\n` +
    `Gas: $${fill.gas_spent_usd.toFixed(2)}\n` +
    `Profit: $${fill.profit_usd.toFixed(2)}\n` +
    `─\n` +
    `Session: ${stats.count} txs | PnL: $${stats.total_profit_usd.toFixed(2)} | Gas: $${stats.total_gas_usd.toFixed(2)}`
  );
}

export async function alertSkipped(state: LiquidationState, reason: string): Promise<void> {
  await send(
    `⏭️ <b>Skipped</b>\n` +
    `Account: <code>${state.user_address.slice(0, 10)}...</code>\n` +
    `LTV: ${(state.ltv_current * 100).toFixed(1)}%\n` +
    `Reason: ${reason}`
  );
}

export async function alertError(context: string, error: Error): Promise<void> {
  await send(
    `🚨 <b>Error</b>\n` +
    `Context: ${context}\n` +
    `<code>${error.message}</code>`
  );
}

export async function alertSessionStart(mode: string, jevMode: string): Promise<void> {
  await send(
    `🤖 <b>Jev Bot Started</b>\n` +
    `Mode: ${mode}\n` +
    `Jev: ${jevMode}`
  );
}

export async function alertSessionEnd(stats: { 
  count: number; 
  total_profit_usd: number; 
  total_gas_usd: number; 
  average_profit_per_liquidation: number;
}): Promise<void> {
  await send(
    `📊 <b>Session Complete</b>\n` +
    `Liquidations: ${stats.count}\n` +
    `Total Profit: $${stats.total_profit_usd.toFixed(2)}\n` +
    `Total Gas: $${stats.total_gas_usd.toFixed(2)}\n` +
    `Avg Profit/Tx: $${stats.average_profit_per_liquidation.toFixed(2)}`
  );
}