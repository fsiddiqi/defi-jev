import { logger } from '@/logging';
import { JevDecision } from '@/jev/classifier';
import { GateCheckResult } from '@/execution/risk-gates';
import { LiquidationState } from '@/state/liquidation-state';

export class EventEmitter {
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();

  on(event: string, callback: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  emit(event: string, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          logger.error(`Error in event listener for '${event}':`, err);
        }
      });
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const eventEmitter = new EventEmitter();

export function emitStateGenerated(state: LiquidationState): void {
  eventEmitter.emit('state:generated', state);
}

export function emitJevDecision(
  decision: JevDecision,
  stateHash: string
): void {
  eventEmitter.emit('jev:decision', { decision, stateHash });
}

export function emitGatesChecked(result: GateCheckResult): void {
  eventEmitter.emit('gates:checked', { result });
}

export function emitLiquidationExecuted(
  state: LiquidationState,
  decision: JevDecision,
  profit_usd: number
): void {
  eventEmitter.emit('liquidation:executed', {
    state,
    decision,
    profit_usd,
  });
}

export function emitSessionStats(stats: {
  count: number;
  total_gas_usd: number;
  total_profit_usd: number;
  average_profit_per_liquidation: number;
}): void {
  eventEmitter.emit('session:stats', stats);
}
