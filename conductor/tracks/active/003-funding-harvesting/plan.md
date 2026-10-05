# Phase 2: Funding Rate Harvesting — Implementation Plan

Spec: [`spec.md`](./spec.md) · Technical spec:
[`docs/FUNDING-HARVEST-SPEC.md`](../../../../docs/FUNDING-HARVEST-SPEC.md)

## Status: 📋 NOT STARTED

Sequencing rule: **Phase 2.1 must complete before Phase 2.4 begins.** The backtester is
cheap and will invalidate or validate the entire agent design. Building execution first means
paying twice if the strategy has no edge.

---

## Phase 2.1 — Backtester (blocking)

- [ ] Add deps: `pg`, `zod`, `undici` (viem/Hyperliquid SDK come in 2.4)
- [ ] `src/hyperliquid/client.ts` — REST wrapper for `api.hyperliquid.xyz/info`
- [ ] **Test:** `fundingHistory` pagination. **Verified constraint: hard cap of 500 points
      per request, silently truncating wider windows.** Assert page count and continuity
- [ ] `src/hyperliquid/funding.ts` — paginated ≥12mo fetch → Postgres
- [ ] `src/hyperliquid/ohlcv.ts` — 1m candles for ETH + SOL
- [ ] `src/backtest/carry-sim.ts` — funding accrued at **exact interval timestamps**
- [ ] **Test:** intrabar liquidation vs. candle high/low. Fixture: short at 3400, liq 3450,
      candle high 3520, close 3390 → must report LIQUIDATED, not "closed fine"
- [ ] `src/backtest/costs.ts` — taker fees both legs, 10bps entry/exit, 25bps rebalance
- [ ] `src/backtest/range-policy.ts` — §1.2 entry conditions, evaluated out-of-sample
- [ ] `src/backtest/report.ts` — emits every §9.4 metric
- [ ] **Test:** known-answer fixture on 500h of real funding data → mean annualized must
      reproduce ~9.86%
- [ ] Verify `candleSnapshot` 1m availability and pagination limits
- [ ] Run backtest, record results in the spec §9.4 table
- [ ] **GATE:** net ROI > passive hold (9.86%/yr gross), ≥200 trades, **0 liquidations**

> If the gate fails, stop. Record the result and reassess the strategy before writing any
> execution code.

## Phase 2.2 — Live data pipeline

- [ ] `src/agents/funding-agent.ts` — three independent cadences (do not unify)
- [ ] `setInterval(marginMonitor, 2000)` — **no AI dependency, no OpenRouter dependency**
- [ ] `setInterval(pollMarketData, 10000)`
- [ ] `setInterval(evalOpportunity, 300000)`
- [ ] Funding poller with staleness limits (§6.4); failed fetch → `null`, **never stale value**
- [ ] Warm 90-day cache at boot; survive restart without recomputing
- [ ] Price reconciliation: exchange + Chainlink, 50 bps divergence → `data_integrity` breaker
- [ ] JSONL logging — all six schemas from spec §5.1
- [ ] Reuse `src/server/events.ts`; extend `src/server/dashboard.ts` for positions/margin
- [ ] Prometheus counters: poll failures, latency, divergence, margin distance
- [ ] Run 7 days, zero unhandled errors

## Phase 2.3 — Jev integration

- [ ] `src/jev/client.ts` — OpenRouter, `temperature: 0.1`, `response_format: json_object`
- [ ] 2s hard timeout via `AbortSignal`
- [ ] `src/jev/funding-schema.ts` — Zod validation of the response contract
- [ ] **Test:** malformed output, missing `action`, `confidence` out of range, oversized
      `recommended_position_usd` → all rejected or clamped, **never passed through**
- [ ] **Test:** `askJev` throws → no entry. Assert no permissive fallback exists on any path
- [ ] Code pre-gates **before** the Jev call (venue health, zscore, percentile)
- [ ] Persist confidence, duration, ROI forecast, `invalidators`
- [ ] Record `jev_error` with latency, retry count, fallback

## Phase 2.4 — Execution

- [ ] `@hyperliquid/sdk` (Hyperliquid is **not EVM** — `viem` cannot reach it)
- [ ] Private key in env only. Never logged, never in a JSONL line
- [ ] `src/execution/dual-leg.ts` — simulate **both** legs before either live order
- [ ] **Test:** spot fills, perp fails → retry hedge ×3 → **unwind spot** if all fail.
      Assert we never end the handler holding an unexplained naked long
- [ ] `src/execution/circuit-breakers.ts` — all seven from §7.2
- [ ] **Test:** `dual_leg_failure` and `margin_critical` are non-auto-reset
- [ ] `src/execution/stress.ts` — 5/10/20/35% shock ladder gates every entry
- [ ] `src/execution/position-manager.ts` — lifecycle, drift bands (±2% correct, ±8% unwind)
- [ ] Limits: $5,000 notional, 1 position, ETH, 2–3× leverage
- [ ] Daily manual reconciliation

## Phase 2.5 — Live validation

- [ ] 20+ completed positions
- [ ] Realized ROI within ±30% of backtest
- [ ] Zero unresolved leg-failure incidents
- [ ] Verify `max_adverse_excursion` never approaches liquidation distance

## Phase 2.6 — Calibration

- [ ] ≥100 live positions
- [ ] Confidence calibration table (bucket → actual win rate)
- [ ] ECE and Brier score
- [ ] Duration MAPE
- [ ] Test `invalidators` actually fire when conditions breach
- [ ] **DECISION POINT:** if buckets are not monotonic, Jev carries no information. Remove it
      and fall back to a zscore threshold rule. Document the finding either way.

---

## Bugs inherited from phase 1

These are documented in `docs/STRATEGIES.md` and are **not** carried into the new modules.
The domain code is being rewritten, which disposes of them. Recording so they are not
reintroduced by copy-paste:

- [ ] `askJev` never called the TypeSafe API — computed local arithmetic, hardcoded
      `is_safe = 0.8`, while the dashboard labelled it "REAL"
- [ ] `risk-gates.ts` gate 6 passed unconditionally — `ltvImprovement` compared a dollar
      profit to a dollar debt
- [ ] Health factor was `Math.random()` in 0.75–0.90, decoupled from the hardcoded balances.
      Real WETH threshold is 83%, so the mock's $250k/$200k position had HF ≈ 1.04 —
      solvent, yet the mock could liquidate it
- [ ] Profit model used an 8% bonus against the real 5%, ignored the close factor, the
      protocol fee, and the collateral→debt swap entirely

## Predecessor tracks

- [ ] `phase-2-aave` — superseded, never started. Rationale in `spec.md`. Retained in git
      history; revive only if funding fails its Phase 2.1 gate
- [x] `001-core-architecture` — [closed](../../closed/001-core-architecture/). Complete in
      `889924e`. Infrastructure reused here; liquidation domain logic rewritten
- [x] `002-observability-alerting` — moved to
      [backlog](../../backlog/002-observability-alerting/). Dashboard, Telegram, and file
      logging shipped in `b1ec7e7`; remaining depth work (`src/metrics.ts`, `/metrics`,
      tests, log rotation) is not a blocker for this track
