// Gas budget ledger — the ceiling on unattended spending. The executor checks
// canSpend() before signing and recordSpend() after every tx (failed included:
// reverse gas is still real gas). Persisted to data/budget.json so restarts
// don't reset a daily cap.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BudgetState {
  dayKey: string; // YYYY-MM-DD
  daySpentUsd: number;
  dayAttempts: number;
  dayFailed: number;
  lastTxAt: string | null;
  lastTxHash: string | null;
  lastTxStatus: "success" | "reverted" | "blocked" | null;
  lastTxGasUsd: number;
  lastTxProfitUsd: number | null;
}

export interface BudgetConfig {
  txCapUsd: number;
  dayCapUsd: number;
  file: string;
}

export const DAY_KEY = () => new Date().toISOString().slice(0, 10);

export function loadBudget(cfg: BudgetConfig): BudgetState {
  try {
    const s = JSON.parse(readFileSync(cfg.file, "utf8")) as BudgetState;
    if (s.dayKey !== DAY_KEY()) {
      return { dayKey: DAY_KEY(), daySpentUsd: 0, dayAttempts: 0, dayFailed: 0, lastTxAt: null, lastTxHash: null, lastTxStatus: null, lastTxGasUsd: 0, lastTxProfitUsd: null };
    }
    return s;
  } catch {
    return { dayKey: DAY_KEY(), daySpentUsd: 0, dayAttempts: 0, dayFailed: 0, lastTxAt: null, lastTxHash: null, lastTxStatus: null, lastTxGasUsd: 0, lastTxProfitUsd: null };
  }
}

function saveBudget(cfg: BudgetConfig, s: BudgetState): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(cfg.file, JSON.stringify(s, null, 2));
}

export function canSpend(s: BudgetState, cfg: BudgetConfig, txGasUsd: number): { ok: boolean; reason: string } {
  if (s.dayKey !== DAY_KEY()) {
    // day rolled over — the caller re-loads; treat as fresh
    s.dayKey = DAY_KEY();
    s.daySpentUsd = 0;
    s.dayAttempts = 0;
    s.dayFailed = 0;
  }
  if (txGasUsd > cfg.txCapUsd) {
    return { ok: false, reason: `tx gas $${txGasUsd.toFixed(2)} > per-tx cap $${cfg.txCapUsd.toFixed(2)}` };
  }
  if (s.daySpentUsd + txGasUsd > cfg.dayCapUsd) {
    return { ok: false, reason: `day budget $${s.daySpentUsd.toFixed(2)} + $${txGasUsd.toFixed(2)} > $${cfg.dayCapUsd.toFixed(2)}` };
  }
  return { ok: true, reason: "" };
}

export function recordSpend(
  cfg: BudgetConfig,
  s: BudgetState,
  r: { gasUsd: number; status: "success" | "reverted" | "blocked"; txHash?: string; profitUsd?: number },
): BudgetState {
  if (s.dayKey !== DAY_KEY()) {
    s.dayKey = DAY_KEY();
    s.daySpentUsd = 0;
    s.dayAttempts = 0;
    s.dayFailed = 0;
  }
  s.dayAttempts++;
  s.daySpentUsd += r.gasUsd;
  if (r.status === "reverted") s.dayFailed++;
  s.lastTxAt = new Date().toISOString();
  s.lastTxHash = r.txHash ?? null;
  s.lastTxStatus = r.status;
  s.lastTxGasUsd = r.gasUsd;
  s.lastTxProfitUsd = r.profitUsd ?? null;
  saveBudget(cfg, s);
  return s;
}