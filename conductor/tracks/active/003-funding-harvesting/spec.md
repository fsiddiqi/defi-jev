# Funding Rate Harvesting (Hyperliquid)

Delta-neutral funding carry agent. Technical detail: [`docs/FUNDING-HARVEST-SPEC.md`](../../../../docs/FUNDING-HARVEST-SPEC.md).

## The strategy

Perp futures trade at a small premium to spot. That premium is paid out hourly between long
and short holders — **longs pay shorts when funding is positive.** Arbitrageurs keep the two
prices pinned by buying spot and shorting perp, and they get paid for it. A carry trader
takes the other side of that payment.

The agent's position is long spot and short perp, equal size. Price moves on the two legs
cancel. What remains is the funding.

```mermaid
flowchart LR
  subgraph pos["Delta-neutral position"]
    S["Long ETH spot"] ---|"equal notional"| P["Short ETH perp"]
  end
  F["Hourly funding<br/>+0.0011% typical"] -->|"longs pay shorts"| P
  U["ETH price moves"] -->|"long gains"| S
  U -->|"short loses"| P
  S --> N["Net price P&L ~ 0"]:::neutral
  P --> N
  P -->|"actual profit"| W["Funding income"]:::win

  classDef win fill:#1b5e20,stroke:#4caf50,color:#fff
  classDef neutral fill:#37474f,stroke:#78909c,color:#fff
```

The premium exists because leverage buyers push perp above spot:

```mermaid
flowchart TB
  A["Leverage demand<br/>pushes perp above spot"] --> B["Funding payments<br/>hourly, longs to shorts"]
  B --> C["Arbitrageur buys spot,<br/>shorts perp, collects funding"]
  C -->|"closes the gap"| A
  B --> W["Carry trader collects<br/>the same funding<br/>9.86%/yr measured"]:::win

  classDef win fill:#1b5e20,stroke:#4caf50,color:#fff
```

## What is actually at risk

Price risk is hedged away. Three things are not:

| Risk | Effect |
|---|---|
| **Funding flips negative** | A short perp position *pays* out. Measured min was −1.73e-5/h. |
| **Costs** | 30 bps round trip. At mean funding that needs **~267 hours (~11 days)** of holding to recover. |
| **Margin** | The short leg can be liquidated before funding arrives. |

That middle row drives the whole design: **this is a low-frequency strategy wearing a
high-frequency costume.** An agent that churns daily loses money on costs alone. Holding
time is the dominant variable, which is why Jev must predict duration and not just
direction.

Return on *capital* is also below the headline rate. Funding accrues on perp notional, but
capital is spot notional plus margin, so at 2–3× leverage the realised rate is
`f / (1 + 1/L)` ≈ **6.6–7.4%/yr** against the 9.86% raw rate. Benchmarks must be compared
like for like.

## Agent loop

Jev gates entries only. Everything that protects capital is deterministic code, because an
LLM round trip is 200–1500 ms and a margin cascade takes seconds.

```mermaid
flowchart TD
  subgraph det["Deterministic — 2s and 10s"]
    M["Margin monitor<br/>every 2s"] --> B["Circuit breakers<br/>halt or unwind"]
    A["Account state<br/>every 10s"] --> B
  end
  subgraph jev["Jev — every 5 min, entries only"]
    G["Code pre-gates<br/>zscore, percentile"] --> J["Jev<br/>confidence, duration"]
    J --> C["Enter, clamped to caps"]
    J -.->|"failure means no entry"| N["Do nothing"]:::neutral
  end

  classDef neutral fill:#37474f,stroke:#78909c,color:#fff
```

## Venue constraints

Read from `https://api.hyperliquid.xyz/info`, 2026-10-05. Hyperliquid is **not EVM** —
`viem` cannot reach it; the official SDK is the only client.

- 234 perp markets. ETH `szDecimals` 4. Exchange permits 25× leverage; we use 2–3×.
- Funding accrues **hourly**.
- **`fundingHistory` hard-caps at 500 points and silently truncates.** A 30-day request
  returned only Sept 5–26. History must be paginated (~18 calls/year).
- 90-day z-score windows need a warm cache — unavailable at cold start.

## Hard constraints

1. **Jev gates entries only.** Exits, rebalancing, and all circuit breakers are code.
2. **Cadences stay asymmetric:** Jev 5 min, account state 10 s, margin monitor 2 s.
3. **Jev failures fail closed.** No decision → no entry. Never a permissive default.
4. **Backtest liquidation against candle high/low, not close.** Zero simulated liquidations
   is a hard gate.
5. **Leverage 2–3×**, never the 25× the exchange permits.
6. **Model output is clamped by hard caps in code**, below the model in the stack.

## Acceptance criteria

```mermaid
flowchart LR
  S1["Stage 1<br/>Backtester"] -->|"BLOCKING<br/>beat passive hold"| S4["Stage 4<br/>Execution"]
  S1 --> S2["Stage 2<br/>Data pipeline"]
  S2 --> S3["Stage 3<br/>Jev"]
  S3 --> S4
  S4 --> S5["Stage 5<br/>Live validation"]
  S5 --> S6["Stage 6<br/>Calibration"]
```

### Stage 1 — Backtester (must land before any execution code)

- [ ] Paginated `fundingHistory`, ≥12 months, verified point counts per page
- [ ] OHLCV at 1m for ETH and SOL
- [ ] Carry simulator accruing funding at exact interval timestamps, not averaged
- [ ] **Intrabar liquidation check against candle high/low**
- [ ] Fee + slippage model (taker both legs, 10 bps entry/exit, 25 bps rebalance)
- [ ] Range-selection policy, evaluated out-of-sample
- [ ] **Beats passive delta-neutral hold on net ROI**
- [ ] **≥200 simulated trades, 0 simulated liquidations**

### Stage 2 — Live data pipeline (no order capability in code)

- [ ] Funding poller with staleness limits; failed fetch returns `null`, never a stale value
- [ ] Warm 90-day cache; survives restart without recomputing
- [ ] 2 s margin monitor, independent of the AI provider
- [ ] Spot/perp price reconciliation, 50 bps divergence alarm
- [ ] Full JSONL decision logging
- [ ] 7 consecutive days without unhandled errors

### Stage 3 — Jev integration

- [ ] OpenRouter client, 2 s hard timeout, `response_format: json_object`, temperature 0.1
- [ ] Schema validation + position cap clamp at the boundary
- [ ] **Fail-closed on every error path**
- [ ] Confidence, `predicted_duration_hours`, `predicted_roi_pct`, `invalidators` persisted
- [ ] Code pre-gates run **before** spending a Jev call
- [ ] `jev_error` logged with fallback recorded

### Stage 4 — Execution

- [ ] Both legs simulated **before** either live order
- [ ] Dual-leg-failure recovery: retry hedge, then **unwind spot** rather than sit naked
- [ ] All circuit breakers armed from the first trade
- [ ] Stress ladder (5/10/20/35% shock) gates every entry
- [ ] Position limit $5,000, one position, ETH only
- [ ] Manual daily reconciliation

### Stage 5 — Live validation

- [ ] ≥20 completed live positions
- [ ] Realized ROI within ±30% of backtest
- [ ] Zero unresolved leg-failure incidents

### Stage 6 — Calibration

- [ ] ≥100 live positions
- [ ] ECE < 0.10, Brier < 0.21
- [ ] Confidence buckets strictly monotonic
- [ ] Duration MAPE < 40%

## Out of scope

Multi-exchange arbitrage, order book modelling, market making, HFT, cross-collateral
optimization, governance, multi-venue support before calibration.

## Success

Confidence is informative **and** net ROI beats passive hold after all costs. Not "it made
money" — that could be a favourable regime. Not "it ran without errors" — a bot that
faithfully loses has failed.

If the calibration curve is flat after 200 trades, Jev is decoration and the correct action
is to remove it for a z-score threshold rule. That is a valid outcome.

## Failure — stop and reassess

- Backtest net ROI below passive hold → no edge, do not proceed
- Any simulated liquidation → sizing is wrong
- Live ROI outside ±30% of backtest → the backtest is not modelling reality
- Flat calibration after 200 trades → remove Jev, keep the threshold rule