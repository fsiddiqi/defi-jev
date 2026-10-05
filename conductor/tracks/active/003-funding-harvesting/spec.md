# Phase 2: Funding Rate Harvesting (Hyperliquid)

Build a delta-neutral funding rate harvesting agent on Hyperliquid, replacing the
`phase-2-aave` liquidation plan.

Full technical specification: [`docs/FUNDING-HARVEST-SPEC.md`](../../../../docs/FUNDING-HARVEST-SPEC.md).
Rationale for abandoning liquidations: [`docs/STRATEGIES.md`](../../../../docs/STRATEGIES.md).

## Why this replaces phase-2-aave

The liquidation plan assumed the edge was in writing correct contract calls. It is not.
Two findings, both verified on-chain and on DefiLlama:

- **Aave V3 is $566M of Base's $6.44B TVL.** Morpho Blue holds $4.565B and generates
  $271.7k/day in fees against Aave's $32.7k. The original plan targeted the smallest major
  lending book on the chain.
- **Contested liquidations are won on latency, not analysis.** Polling a public RPC and
  submitting to the public mempool loses essentially every race to searchers with private
  ordering. A more accurate classifier does not change this.

A funding carry trade has neither problem. It is latency-insensitive, so the infrastructure
requirement that makes the liquidation strategy unviable does not apply.

## Verified venue facts

Read from `https://api.hyperliquid.xyz/info` on 2026-10-05. Hyperliquid is **not an EVM
chain** — `viem` cannot reach it. All access is via REST/WebSocket and the official SDK.

| Fact | Value |
|---|---|
| Perp markets | 234 |
| ETH `szDecimals` | 4 |
| ETH `maxLeverage` (exchange-permitted) | 25 |
| Funding interval | **Hourly** |
| ETH `markPx` at capture | 2698.5 |
| ETH 24h notional volume | ~$1.18B |

`metaAndAssetCtxs` provides, per market: `funding` (current hourly), `premium`, `markPx`,
`oraclePx`, `midPx`, `impactPxs` (size-tiered slippage), `openInterest`, `dayNtlVlm`.
`impactPxs` and `premium` feed the sizing and basis inputs directly.

### API constraints that shape the implementation

- **`fundingHistory` returns at most 500 points** and silently truncates wider windows. A
  30-day request returned Sept 5–26. **History must be paginated** — ~18 calls per year.
- `candleSnapshot` takes `req: { coin, interval, startTime, endTime }`. Intervals observed:
  `1m`, `1h`. Point-in-time funding plus OHLCV at 1m is sufficient for §9.
- 90-day `zscore` windows require a warm cache. Cannot be computed at cold start.

### Measured baseline

500 hourly funding observations:

| Metric | Value |
|---|---|
| Mean hourly funding | 1.125e-5 |
| **Mean annualized** | **9.86%** |
| Hours positive | 470 / 500 (94%) |
| Max hourly | 5.12e-5 → 44.8% annualized |
| Min hourly | -1.73e-5 |

**Passive delta-neutral hold yields ~9.9%/yr gross.** That is the benchmark the agent must
beat after gas, fees, and the 30 bps round-trip slippage budget. A strategy that earns less
than this has added nothing, regardless of Sharpe.

## Reuse vs. rewrite

Not from scratch. Roughly half the existing code carries over.

**Reuse as-is:** `src/logging.ts` (pino + file transport),
`src/server/telegram.ts` (alert helpers), `src/server/events.ts` (event bus — §8.3 of the
spec relies on it).

**Adapt:** `src/server/dashboard.ts` (728 lines, the largest asset in the repo — SSE pattern
transfers; the domain fields become positions and margin state instead of liquidations),
`src/execution/risk-gates.ts` (the *pattern* — hardcoded limits, never AI-gated — transfers;
the liquidation gate logic does not).

**Rewrite:** funding aggregation, position lifecycle, margin monitoring, cross-venue
execution, Postgres state, OpenRouter client, the backtester.

## Non-negotiable design constraints

1. **Jev gates entries only.** Exits, rebalancing, and every circuit breaker are
   deterministic code. An LLM round-trip is 200–1500ms; a margin cascade takes seconds.
2. **Cadences stay asymmetric.** Jev at 5 min, account state at 10s, margin monitor at 2s.
3. **Jev failures fail closed.** No decision → no entry. Never a permissive default.
4. **Backtest checks liquidation against candle high/low, not close.** Zero simulated
   liquidations is a hard gate.
5. **Leverage 2–3×, never the 25× the exchange permits.**
6. **Model output is clamped by hard caps in code**, below the model in the stack.

## Acceptance Criteria

### Phase 2.1 — Backtester (must land before any execution code)

- [ ] Paginated `fundingHistory` fetch, ≥12 months, with verified point counts per page
- [ ] OHLCV fetch at 1m for ETH and SOL
- [ ] Carry simulator: funding accrued at exact interval timestamps, not averaged
- [ ] **Intrabar liquidation check against candle high/low**
- [ ] Fee + slippage model (taker both legs, 10 bps entry/exit, 25 bps rebalance)
- [ ] Range-selection policy implementing §1.2 of the spec, evaluated out-of-sample
- [ ] Report emits every §9.4 metric
- [ ] **Must beat passive delta-neutral hold (9.86%/yr gross) on net ROI**
- [ ] Must show ≥200 simulated trades and 0 simulated liquidations

### Phase 2.2 — Live data pipeline (no order capability in code)

- [ ] Funding poller with staleness limits from spec §6.4
- [ ] Warm 90-day funding cache; survive restart
- [ ] 2s margin monitor, independent of the AI provider
- [ ] Spot/perp price reconciliation with 50 bps divergence alarm
- [ ] Full JSONL decision logging (all schemas in spec §5.1)
- [ ] Prometheus counters for poll failures, latency, divergence
- [ ] 7 consecutive days without unhandled errors

### Phase 2.3 — Jev integration

- [ ] OpenRouter client with 2s hard timeout
- [ ] `response_format: json_object`, temperature 0.1
- [ ] Zod validation + position cap clamp at the boundary
- [ ] **Fail-closed on every error path**
- [ ] Confidence, `predicted_duration_hours`, `predicted_roi_pct`, `invalidators` persisted
- [ ] Code pre-gates run **before** spending a Jev call
- [ ] `jev_error` logged with fallback recorded

### Phase 2.4 — Execution

- [ ] Both legs simulated successfully **before** either live order
- [ ] Dual-leg-failure recovery: retry hedge, then **unwind spot** rather than sit naked
- [ ] All circuit breakers from spec §7.2 armed from the first trade
- [ ] Stress test (5/10/20/35% shock ladder) gates every entry
- [ ] Position limit $5,000, one position, ETH only

### Phase 2.5 — Live validation

- [ ] ≥20 completed live positions
- [ ] Realized ROI within ±30% of backtest
- [ ] Zero unresolved leg-failure incidents
- [ ] Manual daily position reconciliation

### Phase 2.6 — Calibration

- [ ] ≥100 live positions
- [ ] ECE < 0.10, Brier < 0.21
- [ ] Confidence buckets strictly monotonic
- [ ] Duration MAPE < 40%

## Explicitly out of scope

Multi-exchange arbitrage, order book modelling, market making, HFT, cross-collateral
optimization, governance participation, live multi-venue support (single venue until
calibrated).

## Success Criteria

The strategy succeeds if **confidence is informative and net ROI beats passive hold after
all costs.** Not if it made money — that could be a favorable regime — and not if it ran
without errors, since a bot that faithfully loses has still failed.

If the calibration curve is flat after 200 trades, Jev is decoration and the correct action
is to remove it: a threshold rule on funding `zscore` achieves the same result for a
fraction of the latency and cost. That is a valid outcome of this phase.

## Failure Conditions — stop and reassess

- Backtest net ROI < passive hold → the strategy has no edge; do not proceed
- Any simulated liquidation → sizing is wrong; fix before proceeding
- Live ROI outside ±30% of backtest → backtest is not modeling reality; stop
- Jev calibration flat after 200 trades → remove Jev, keep the threshold rule
