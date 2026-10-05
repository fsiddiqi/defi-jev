# Funding Rate Harvesting — Implementation Specification

Autonomous delta-neutral funding rate harvesting agent. Jev (System One) gates entries;
deterministic code governs exits, rebalancing, and all safety controls.

**Status:** draft for review
**Supersedes:** nothing — parallel to `docs/STRATEGIES.md`, which argues liquidations are
structurally unwinnable at current infrastructure. This spec takes the opposite position: a
carry trade is **latency-insensitive**, so the infrastructure that kills a liquidation bot
does not kill this one. That asymmetry is the reason to build it.

---

## 0. Core design principles

Read this section before the rest. It dictates everything downstream.

### 0.1 Jev gates entries only

```
        JEV DECIDES              CODE DECIDES
   ┌────────────────────┐   ┌──────────────────────────────┐
   │ Should I enter?    │   │ When do I exit?              │
   │ Regime classify    │   │ Margin health                │
   │ Position sizing    │   │ Drift correction             │
   │                    │   │ Circuit breakers             │
   │ 200–1500ms OK      │   │ Hard halt                    │
   │ Can afford latency │   │ SUB-SECOND REQUIRED          │
   └────────────────────┘   └──────────────────────────────┘
```

An LLM inference round-trip is 200–1500ms. A perp margin cascade unfolds over seconds. Any
safety-critical path that depends on Jev is architecturally unsound. Jev contributes
*judgment about opportunities* — something that tolerates latency. Code contributes
*survival* — something that does not.

### 0.2 Funding is the PnL driver, not price

This is the single most important thing to get right in the backtest. In a delta-neutral
position, price moves cancel between legs. **Your PnL is the funding accrual, minus costs.**

```
daily PnL%  ≈  24 × hourly_funding_rate  −  daily_funding_cost − rebalance_cost − borrow_cost
```

Sanity anchors for annualization (pure arithmetic, no venue dependency):

- 0.01% per 8h → 0.03%/day → **~10.9%/yr**
- 0.01% per hour → 0.24%/day → **~87.6%/yr**

If your backtest shows a mean funding rate implying >50% annualized with no directional
risk, the model is wrong, not the market.

### 0.3 Cross-venue liquidation is the real risk

Position: long $X spot on venue A, short $X perp on venue B. In a steady uptrend these
offset and you collect funding. The danger is not direction — it is that **the perp leg
liquidates on an intrabar move before your spot leg recovers**, and you realize the loss on
one side while holding an illiquid or stale asset on the other.

If spot and perp are on different venues, you accept:
- CEX/exchange withdrawal latency
- Spot venue outage or API failure during a margin event
- Custodial risk on the collateral

Rule: **the perp leg must always be over-collateralized by a margin that survives a single
adverse candle**, not merely a static margin ratio. See §3.5.

---

## 1. Jev's Decision Model

### 1.1 Input signals

Feeding raw funding to an LLM wastes it — the numbers are trivially parseable. Feed Jev
*derived, hard-to-compute context* and let it reason over structure. That is where a model
adds value over `if (rate > x) enter`.

```jsonc
{
  "symbol": "ETH",
  "funding": {
    "current_hourly_pct": 0.0087,
    "weighted_8h_equivalent": 0.0091,
    "zscore_vs_90d": 2.34,
    "percentile_vs_1y": 0.97,
    "hours_persistent_same_sign": 31,
    "predicted_flip_probability_24h": 0.18
  },
  "price": {
    "last": 3412.50,
    "realized_vol_24h_annualized": 0.62,
    "vol_percentile_vs_90d": 0.44,
    "trend_7d": "flat"
  },
  "basis": {
    "perp_premium_vs_spot_pct": 0.081,
    "annualized": 7.39
  },
  "regime": "bullish_trending",
  "account": {
    "equity_usd": 50000,
    "deployed_usd": 40000,
    "available_margin_pct": 0.34,
    "open_positions": 0
  },
  "venue_health": {
    "spot_venue": "ok",
    "perp_venue": "ok",
    "last_api_success_age_s": 4
  }
}
```

**On `zscore_vs_90d` and the other derived fields.** These are where the strategy's
information content lives. A single funding rate is not tradeable — rates mean-revert, and
entering on a spike that reverts in the next interval captures the worst entry. The
question Jev answers is *"is this level persistent or is it about to collapse,"* which is a
pattern question, not a threshold question.

### 1.2 Decision logic

Jev returns a routing decision. It does **not** emit a threshold rule; thresholds are
enforced in code (§7) and Jev operates within them.

| Condition | Action |
|---|---|
| `zscore > 2.0` **and** `hours_persistent > 12` | Candidate — full size if confidence holds |
| `zscore > 2.0` **and** `hours_persistent < 4` | Reject — likely transient spike |
| `percentile < 0.90` | Reject — not enough edge |
| `predicted_flip_probability > 0.35` | Reject — carry may not survive entry costs |
| `venue_health != ok` | Reject — hard veto, code-enforced regardless of Jev |
| `vol_percentile > 0.95` | Reject — liquidation risk too high for the margin buffer |

### 1.3 Confidence scoring

Jev reports confidence in `[0, 1]`. This is a *self-assessment* and should be treated as
uncalibrated until §5.3 proves otherwise. Store it anyway — the calibration curve is
produced by tracking it, which is the entire point of logging it.

Interpretation during calibration:

- `> 0.75` — take, full size
- `0.60–0.75` — take at half size
- `< 0.60` — skip

### 1.4 Output contract

```jsonc
{
  "action": "ENTER" | "HOLD" | "SKIP",
  "confidence": 0.81,
  "predicted_duration_hours": 42,
  "predicted_roi_pct": 0.94,
  "recommended_position_usd": 32000,
  "reasoning": "Funding at 97th percentile, 31h persistent, perp premium annualized 7.4% "
             + "supports carry without imminent mean reversion. Vol mid-range; margin buffer "
             + "intact at 34%.",
  "invalidators": ["funding below 0.003% for 2 consecutive hours", "vol > 95th percentile"]
}
```

`invalidators` is the field to insist on. It forces the model to name conditions that would
void its own thesis, and code checks them (§2.4). A model that cannot say what would falsify
its call has not reasoned about it.

---

## 2. Operational Workflow

### 2.1 Polling cadence

Funding accrues on discrete intervals (hourly on Hyperliquid, 8h on most EVM perps). Polling
faster than the accrual interval adds cost and noise without adding information.

| Activity | Cadence | Rationale |
|---|---|---|
| Funding rate read | 60s | 1–2% of interval; catches the timestamp |
| Mark price / liquidation distance | **5s** | This is the safety-critical path |
| Spot price | 15s | Balance against lag; mark price is perp-native |
| Account state read | 10s | Drift and margin |
| Jev inference | 5 min, and on funding change | Expensive; no value more often |
| Health factor / margin check | 2s | Deterministic hard stop |

The asymmetry is deliberate: **Jev runs at 5-minute cadence, margin monitoring at 2 seconds.**
If you make those the same number, you have either made Jev uselessly slow or margin
monitoring uselessly blind.

### 2.2 Data sources

| Need | Source | Latency tolerance |
|---|---|---|
| Funding rate | Exchange API (`info` endpoint) | < 60s |
| Mark price + liq price | Exchange API, **not** spot | < 5s |
| Spot price | Exchange spot API or Chainlink | < 15s |
| Position state | Exchange API, private | < 10s |

**Use the exchange's mark price for liquidation distance.** Liquidation triggers off mark
price, not last-trade. Computing it from spot introduces basis drift exactly when it matters.

### 2.3 Position lifecycle

```
   ┌──────────┐   funding z>2 & persistent      ┌──────────┐
   │  FLAT    │─────────────────────────────────▶│  PENDING │
   │          │◀─────────────────────────────────│          │
   └──────────┘   order failed / timeout         └──────────┘
        ▲                                          │ both legs
        │                                          │ filled
        │                                          ▼
        │      drift > tol OR vol spike        ┌──────────┐
        ├──────────────────────────────────────│   OPEN   │
        │◀─────────────────────────────────────│          │
        │      funding compresses / margin      └──────────┘
        │      risk / invalidator / time limit
        ▼
   ┌──────────┐
   │UNWINDING │
   └──────────┘
```

`PENDING` exists because legs are not atomic across venues. Handling of the
spot-succeeds-perp-fails case is in §4.3 and is the highest-risk code in this system.

### 2.4 Rebalance triggers

| Trigger | Threshold | Action |
|---|---|---|
| Delta drift | > 2% of notional | Correct |
| Liquidation distance | < 25% | Correct, elevated urgency |
| Liquidation distance | < 15% | **Hard halt new entries**, unwind only |
| Funding flips negative | 2 consecutive hours | Review; unwind if persists 6h |
| Jev invalidator triggered | any | Review exit |
| Time-based review | every 6h | Re-evaluate thesis |

### 2.5 Exit triggers

Ordered by priority — first match wins:

1. **Liquidation distance < 12%** → unwind immediately, highest priority
2. **Delta drift > 8%** → unwind and re-enter clean
3. **Funding negative 6 consecutive hours** → unwind (carry thesis dead)
4. **Jev invalidator** → unwind
5. **Time limit: 14 days** → unwind regardless (bound capital lockup)
6. **Equity drawdown > 10% from peak** → unwind, session halt

---

## 3. Delta-Neutral Hedge Mechanics

### 3.1 Sizing formula

```pseudocode
function sizePosition(fundingRate, equity, config) -> {spotUsd, perpQty, marginUsd} {
    // 1. Determine effective notional. Volatility caps exposure, not just capital.
    volScalar = clamp(1.0 - (annualizedVol - 0.40) / 0.60, 0.3, 1.0)
    targetNotional = min(
        equity * config.maxLeverage,
        equity * config.maxAllocationPct,
        config.maxNotionalUsd
    ) * volScalar

    // 2. Conversion: carry decays as basis compresses. Stop paying for carry you won't get.
    basisAnnualized = perpPremiumVsSpot * 365 * 24
    if (basisAnnualized < fundingAnnualized * config.minBasisRatio) {
        reject("basis compression makes carry uneconomic")
    }

    // 3. Delta hedge. perpQty is in units; spot is in value.
    spotUsd    = targetNotional
    perpQty    = targetNotional / markPrice

    // 4. Margin must survive an adverse move, not just meet maintenance (see §3.5)
    requiredMargin = worstCaseLoss(targetNotional, config.stressVol) * config.marginBuffer
    marginUsd = max(requiredMargin, targetNotional / config.maxLeverage)

    if (marginUsd > equity * config.maxMarginPct) {
        reject("margin requirement exceeds allocation cap")
    }
    return { spotUsd, perpQty, marginUsd }
}
```

### 3.2 Perfect neutrality vs. bounded drift

Do **not** attempt perfect delta neutrality. Target zero and you rebalance on every tick,
paying gas and slippage to correct noise. Instead:

| Band | Tolerance | Action |
|---|---|---|
| Target | 0% drift | — |
| Accept | ±2% | None |
| Correct | > 2% | Rebalance |
| Unwind | > 8% | Exit |

### 3.3 Collateral management

```
Equity $50k, target notional $32k

  Spot leg:   $32k ETH        (held on spot venue)
  Perp margin: $14.5k USDC    (collateral on perp venue)
  Free:        $3.5k          (buffer for slippage + fees)

  Perp leverage = $32k / $14.5k ≈ 2.2x
```

Leverage around **2–3×**, not the 10–20× the perps permit. Maximum leverage optimizes the
return on an event where nothing goes wrong, and is catastrophic on the event where
something does. At 2.2×, a 45% adverse move is required to liquidate; at 10× it is 10%.

### 3.4 Rebalancing frequency

Drift-triggered, not scheduled. Additionally rebalance when **any** hold:

- Funding has flipped sign once (thesis invalidated even if drift is fine)
- Volatility moves more than 1 standard deviation

### 3.5 Liquidation safety buffer

Compute distance to liquidation from the venue's mark price and your maintenance margin:

```pseudocode
function liquidationDistance(markPrice, liquidationPrice, perpQty, marginUsd) -> pct {
    // Direction-aware: a short liquidates on the way UP
    adverseMove = (liquidationPrice - markPrice) / markPrice   // positive = short risk
    lossAtLiq   = abs(perpQty) * adverseMove * markPrice
    cushion     = (marginUsd - lossAtLiq) / marginUsd
    return cushion   // 0.0 = at liquidation, 1.0 = no margin at all
}
```

Gate: **no position opens unless post-entry distance ≥ 25%.** At 2.2× leverage that is
roughly a 20% adverse move, which no plausible intrabar reaches.

---

## 4. Execution Architecture

### 4.1 RPC sequence

```
1. GET  funding rate + mark price + liq price    (perp venue)
2. GET  spot price                                 (spot venue)
3. GET  account state: equity, margin, positions   (perp venue)
4. POST OpenRouter → Jev                            (only if thresholds pre-pass in code)
5. POST simulate spot order                         (must succeed before proceeding)
6. POST simulate perp order                         (must succeed before proceeding)
7. EXECUTE spot order
8. EXECUTE perp order        ← window of risk opens here
9. VERIFY delta; correct if drift > 2%
```

Both simulations **before** either live order. A live order that reverts after its
counterpart filled leaves you naked.

### 4.2 Transaction structure

**Not atomic.** Different venues, different chains, no shared transaction. The sequence in
§4.1 is sequential and you live with the gap between step 7 and step 8.

Mitigations:

- Minimize the window: pre-sign the perp order, submit immediately after spot confirms
- Pre-fund both venues so no withdrawal sits in the critical path
- Size the first leg smaller (spot first at 60%, then top up) to bound the naked window

### 4.3 Partial failure — the dangerous case

This is the highest-risk code path in the system.

```
SCENARIO A: spot fails, perp not sent        → SAFE. No position. Retry or abort.
SCENARIO B: spot succeeds, perp fails       → NAKED LONG. Unexpected exposure.
SCENARIO C: both succeed                    → Hedge established.
SCENARIO D: spot succeeds, perp partially  → PARTIALLY NAKED. Size-dependent exposure.
```

Handling for **B and D**:

```pseudocode
function onSpotFilledPerpFailed(spotFilledUsd, perpFilledUsd) {
    nakedExposure = spotFilledUsd - perpFilledUsd

    // Immediate: attempt perp hedge with reduced size, aggressive limit
    for attempt in 1..3:
        result = executePerpReduceOnly(nakedExposure)
        if result.success: return

        // Failing: unwind the spot leg rather than sit naked
        executeSpotSell(nakedExposure)          // revert to flat
        alertCritical("both legs failed, reverted to flat")
        circuitBreaker.trip("dual-leg-failure")
}
```

The fallback is **unwinding the spot leg, not waiting.** A naked long in a market you
entered for a carry trade is pure directional risk with no thesis behind it. If the hedge
can't be established, the trade never existed.

### 4.4 Slippage budget

| Leg | Limit | Rationale |
|---|---|---|
| Spot | 10 bps | ETH is deep; tighter is achievable |
| Perp | 10 bps | Same |
| Rebalance | 25 bps | Accept worse to correct risk promptly |

Per-trade slippage budget: **30 bps round trip**. With funding at 0.009%/hour, this is
recovered in ~20 minutes of positive carry. On a position held 42 hours, slippage is noise.
On one held 20 minutes, it is the entire trade. The backtest must model this asymmetry —
short holds are unprofitable and that is a real result, not a modeling artifact.

---

## 5. Logging & Observability

### 5.1 JSONL schemas

Every line is one event. Append-only, one JSON object per line, in `logs/`.

**Decision (Jev consulted)**

```json
{"ts":"2026-10-05T14:32:11.204Z","event":"decision","run_id":"01JQ8X2M4N","symbol":"ETH","inputs":{"funding_hourly_pct":0.0087,"zscore":2.34,"percentile_1y":0.97,"hours_persistent":31,"vol_24h":0.62,"vol_percentile":0.44,"basis_annualized":7.39,"regime":"bullish_trending"},"jev":{"action":"ENTER","confidence":0.81,"predicted_duration_hours":42,"predicted_roi_pct":0.94,"latency_ms":612},"code_gates":{"pre_pass":true,"venue_ok":true},"decision":"ENTER","position_usd":32000}
```

**Entry**

```json
{"ts":"2026-10-05T14:32:48.771Z","event":"entry","run_id":"01JQ8X2M4N","symbol":"ETH","spot":{"qty_eth":9.38,"notional_usd":32009.44,"slippage_bps":4.2,"venue":"spot_custodian","tx_hash":"0x..."},"perp":{"qty_eth":-9.38,"notional_usd":32000.11,"slippage_bps":3.1,"venue":"hyperliquid","tx_hash":"0x...","leverage":2.21},"residual_delta_pct":0.03,"duration_ms":6234}
```

**Leg failure**

```json
{"ts":"2026-10-05T15:08:02.113Z","event":"partial_fill_recovery","run_id":"01JQ8X2M4N","symbol":"ETH","spot_filled_usd":32009.44,"perp_filled_usd":0,"naked_exposure_usd":32009.44,"recovery":"perp_retry","recovery_attempts":2,"recovery_success":true,"duration_ms":1877}
```

**Exit**

```json
{"ts":"2026-10-05T16:14:03.552Z","event":"exit","run_id":"01JQ8X2M4N","symbol":"ETH","reason":"funding_negative_6h","funding_at_entry_pct":0.0087,"funding_at_exit_pct":-0.0012,"held_hours":1.68,"funding_accrued_usd":42.11,"fees_usd":18.90,"slippage_usd":22.44,"realized_pnl_usd":0.77,"realized_roi_pct":0.0024,"max_favorable_excursion_usd":118.30,"max_adverse_excursion_usd":-64.20}
```

**Safety control trip**

```json
{"ts":"2026-10-05T16:20:00.001Z","event":"circuit_breaker","run_id":"01JQ8X2M4N","breaker":"max_daily_loss","tripped":true,"value":0.041,"threshold":0.03,"action":"block_new_entries","auto_reset":false}
```

**Jev failure**

```json
{"ts":"2026-10-05T14:35:00.882Z","event":"jev_error","run_id":"01JQ8X2M4N","error":"rate_limit_429","latency_ms":30211,"retry_count":3,"fallback":"no_entry","note":"fail-closed: uncertainty never opens a position"}
```

That last one matters: **Jev failures must fail closed.** A missing decision means no entry.
Never default to a permissive action on error.

### 5.2 Outcome tracking

Per position, joined on `run_id`:

| Metric | Why it matters |
|---|---|
| `realized_roi_pct` | The only number that matters |
| `funding_accrued_usd` | Isolates carry from execution quality |
| `fees + slippage` | Cost of being wrong about *timing* |
| `max_adverse_excursion` | Would it have liquidated? By how much? |
| `held_hours` | Validates predicted duration |
| `predicted vs actual ROI` | Forecast error input |

`max_adverse_excursion` is the field that tells you whether your margin buffer is real. If
MAE approaches your liquidation distance, you were closer than you thought.

### 5.3 Calibration metrics

The reason to log `confidence` is to produce this table.

**Confidence calibration**

```
bucket_confidence:  predict(P(profit | conf in bucket))
  0.55–0.60 →  n=12,  actual 0.50,  gap -0.05
  0.60–0.65 →  n=23,  actual 0.61,  gap +0.01
  0.65–0.70 →  n=31,  actual 0.58,  gap -0.07
  0.70–0.75 →  n=44,  actual 0.70,  gap -0.01
  0.75–0.80 →  n=58,  actual 0.71,  gap -0.06
  0.80–0.85 →  n=67,  actual 0.74,  gap -0.10
```

**Expected Calibration Error (ECE):**

```
ECE = Σ (n_b / N) × |predicted_b − actual_b|
```

Also track **Brier score** (`mean((outcome − conf)²)`, lower better) and **forecast error**
(`actual_roi − predicted_roi`) split by predicted duration bucket.

**Be honest about sample size.** With a 60%-minimum gate, you will only ever observe the
high-confidence regime — roughly 60–70% of trades. You cannot calibrate the low end, and
that is fine: you never trade it. But it means N grows slowly, and no conclusion is
statistically meaningful below ~100 positions. Say so in the report rather than reading
noise.

---

## 6. Data Pipeline

### 6.1 Funding aggregation

```pseudocode
async function pollFunding(venue, symbol) {
    try {
        res = await withTimeout(fetch(`${venue}/info`), 3000)
        rates = parseFundingHistory(res)         // venue-specific
        return {
            current:   rates.latest,
            zscore:    (rates.latest - mean90) / stddev90,
            percentile: rank(rates.latest, rates.1y),
            persistenceHours: consecutiveSameSign(rates),
            staleness: now() - rates.latestTimestamp
        }
    } catch (err) {
        metrics.increment("funding.poll.failed", { venue })
        return null                              // caller treats null as NO ENTRY
    }
}
```

Three rules:

- **A failed fetch is `null`, never a stale value.** Trading on stale funding is how you
  enter a position that no longer exists.
- **Independent health tracking per venue.** One venue failing must not block the other.
- **Warm the history cache before first use.** `zscore_90d` needs 90 days; you cannot
  compute it at startup. Pre-fetch at boot or persist it across restarts.

### 6.2 Spot price feeds

Use **both**, with a defined precedence:

1. Exchange spot API (fast, matches your execution venue)
2. Chainlink (independent, slower, useful as a sanity check)

If they diverge > 50 bps, treat it as a data-integrity fault and block entry. On a
delta-neutral strategy the spot price's only jobs are sizing and basis computation, so the
50 bps band is about catching broken feeds, not arbitraging.

### 6.3 Margin monitoring

```pseudocode
every 2 seconds:
    markPrice    = fetchMarkPrice()
    liqPrice     = fetchLiqPrice()
    marginRatio  = fetchMarginRatio()

    distance = liquidationDistance(markPrice, liqPrice, position.qty, marginUsd)

    if distance < 0.12:  unwindNow()                    // §2.5 priority 1
    elif distance < 0.15: breaker.blockEntries = true
    elif distance < 0.25: rebalance()

    // Independent hard stop — never gated on anything else
    if marginRatio < maintenanceMargin + 0.02:
        breaker.trip("margin_critical")
```

This loop has **no Jev dependency and no network dependency on the AI provider.** If
OpenRouter is down, margin monitoring is unaffected. That isolation is deliberate.

### 6.4 Refresh cadence

| Data | Interval | Staleness limit |
|---|---|---|
| Funding rate | 60s | 5 min → else block entry |
| Mark price | 5s | 30s → else unwind |
| Liquidation price | 5s | 30s → else unwind |
| Spot price | 15s | 2 min → else block entry |
| Account state | 10s | 1 min → else block entry |
| Margin ratio | 2s | — |

---

## 7. Risk Controls

All hardcoded. None consults Jev.

### 7.1 Position and allocation limits

| Control | Limit |
|---|---|
| Max position notional | $50,000 |
| Max leverage | 3× |
| Max capital per venue | 60% of equity |
| Max concurrent positions | 3 |
| Max new entries per hour | 2 |
| Min margin buffer at entry | 25% |

### 7.2 Circuit breakers

| Breaker | Threshold | Action | Auto-reset |
|---|---|---|---|
| `daily_loss` | 3% of equity | Block entries 24h | No — manual |
| `max_dd` | 10% from peak | Halt all, unwind all | No — manual |
| `margin_critical` | Margin ratio near maintenance | Unwind immediately | No |
| `dual_leg_failure` | Both legs failed once | Block entries 24h | No |
| `data_integrity` | Price feeds diverge > 50 bps | Block entries until resolved | Yes |
| `jev_unavailable` | 3 consecutive failures | Block entries 1h | Yes |
| `latency_spike` | Mark price age > 30s | Unwind and halt | Yes |

Most breakers are **not** auto-reset. A bot that automatically resumes after a serious
failure is a bot that repeats the failure.

### 7.3 Liquidation prevention

```
Entry gate:   post-entry liquidation distance ≥ 25%
Live gate:    continuous at 2s cadence
Hard stop:    unwind at < 12%
Escalation:   block entries at < 15%
```

And the stress test that must run **before** every entry:

```pseudocode
function stressTest(notional, leverage, config) -> bool {
    for shock in [0.05, 0.10, 0.20, 0.35]:
        loss = notional * shock
        remainingMargin = marginUsd - loss
        if remainingMargin / marginUsd < config.minBuffer:
            reject("leverages out at ${shock*100}% adverse move")
    return true
}
```

If any shock in that ladder breaks the buffer, the position is too leveraged — regardless of
what Jev's confidence says.

---

## 8. Node.js Integration

### 8.1 OpenRouter call

```typescript
interface JevRequest {
  model: string;            // via OpenRouter
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;      // 0.1 — this is a classification task
  max_tokens: number;
  response_format: { type: 'json_object' };
}

interface JevResponse {
  action: 'ENTER' | 'HOLD' | 'SKIP';
  confidence: number;
  predicted_duration_hours: number;
  predicted_roi_pct: number;
  recommended_position_usd: number;
  reasoning: string;
  invalidators: string[];
}
```

```typescript
async function askJev(inputs: SignalBundle): Promise<JevResponse> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'defi-jev-funding',
    },
    body: JSON.stringify({
      model: process.env.JEV_MODEL,
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: FUNDING_SYSTEM_PROMPT,   // §1 rules encoded as prose
        },
        { role: 'user', content: JSON.stringify(inputs) },
      ],
    }),
    signal: AbortSignal.timeout(2000),      // hard 2s ceiling
  });

  if (!res.ok) throw new Error(`jev_http_${res.status}`);
  const json = await res.json();
  return validateAndClamp(JSON.parse(json.choices[0].message.content));
}
```

`validateAndClamp` is not optional — malformed model output must never reach execution:

```typescript
function validateAndClamp(raw: unknown): JevResponse {
  const d = raw as JevResponse;
  if (!['ENTER', 'HOLD', 'SKIP'].includes(d?.action)) throw new Error('jev_bad_action');
  if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) {
    throw new Error('jev_bad_confidence');
  }
  d.confidence = Math.min(d.confidence, 1);
  d.recommended_position_usd = Math.min(
    d.recommended_position_usd ?? 0,
    CONFIG.maxPositionUsd,     // model cannot exceed the hard cap
  );
  return d;
}
```

The cap clamp matters: a model proposing $5M is a model error, and the cap must live below
the model in the stack.

### 8.2 State storage

| Data | Store | Why |
|---|---|---|
| Open positions | PostgreSQL | Must survive restart |
| Funding history cache | PostgreSQL (timeseries) | 90d windows need persistence |
| Decision log | JSONL files | Append-only, greppable |
| Equity curve | PostgreSQL | Calibration analysis |
| Jev latency/error counters | In-memory + Prometheus | Reset each run is fine |
| Market data cache | In-memory | Ephemeral, refetchable |

Postgres, not Redis: position state is a correctness concern and must be durable. Redis is
reasonable only as a write-through cache in front of it.

### 8.3 Loop structure

```typescript
// Three independent cadences. Do NOT unify them.
setInterval(marginMonitor,  2000);   // safety-critical, no AI
setInterval(pollMarketData, 10000);  // data refresh
setInterval(evalOpportunity,300000); // Jev, expensive
```

```typescript
class FundingAgent extends EventEmitter {
  async start() {
    await this.warmFundingHistory();       // 90d lookback must exist before first decision
    await this.assertVenueHealth();
    this.emit('ready');
    setInterval(() => this.marginMonitor(), 2000);
    setInterval(() => this.pollMarketData(), 10000);
    setInterval(() => this.evalOpportunity(), 300000);
  }

  private async evalOpportunity() {
    const signals = await this.buildSignals();
    if (!signals) return this.emit('no-entry', 'data_unavailable');

    // Code pre-gate BEFORE spending a Jev call
    if (!this.preGatesPass(signals)) return this.emit('no-entry', 'pre_gate');

    let decision;
    try {
      decision = await askJev(signals);          // fail-closed on throw
    } catch (err) {
      this.metrics.increment('jev.failed');
      return this.emit('no-entry', 'jev_unavailable');   // never permissive fallback
    }

    if (decision.action !== 'ENTER') return this.emit('skipped', decision);
    if (this.breaker.blocked()) return this.emit('no-entry', 'breaker');

    const sized = this.sizePosition(decision, signals);
    if (!sized.ok) return this.emit('rejected', sized.reason);
    if (!this.stressTest(sized)) return this.emit('rejected', 'stress_failed');

    await this.executeEntry(sized);               // §4.1 sequence
  }
}
```

Reuse your existing `EventEmitter` from `src/server/events.ts` and the dashboard — the
event-driven pipeline already matches this shape.

### 8.4 Dependencies

```jsonc
{
  "dependencies": {
    "viem": "^2.15.0",              // only for EVM venues (GMX on Arbitrum)
    "@hyperliquid/sdk": "^0.3",     // if starting on Hyperliquid
    "pg": "^8.11.0",
    "ioredis": "^5.3.0",            // cache only, not source of truth
    "pino": "^8.17.2",              // already present
    "prom-client": "^15.1.3",      // already present
    "zod": "^3.22.0",              // validate Jev output at the boundary
    "undici": "^6.5.0"             // stable timeouts, connection reuse
  }
}
```

Note `viem` cannot reach Hyperliquid or dYdX. That is the tooling mismatch flagged up front.

---

## 9. Backtest Strategy

**Do this before writing any execution code.** It is the cheapest possible way to find out
whether the strategy has edge.

### 9.1 Data

- Exchange funding rate history (hourly, ≥12 months — needs to span multiple regimes)
- OHLCV at 1m for ETH and SOL
- Exchange fee schedule
- Historical index/spot price for basis

### 9.2 What the simulation must model

| Assumption | Value | Note |
|---|---|---|
| Execution lag | 1–3 s | Model at p50 and p95, not mean |
| Slippage | 10 bps entry/exit | 25 bps for rebalances |
| Fees | taker rate, both legs | Venue-specific |
| Funding accrual | Exact, at interval timestamps | Not averaged — spikes are the signal |
| Liquidation check | **Against candle high/low, not close** | See below |
| Rebalance | Drift > 2%, charged | |

### 9.3 The intrabar trap

The single most common backtest error in this strategy: checking liquidation and margin
health at candle *close*.

```
Backtest says:  candle O=3400  H=3520  L=3380  C=3390
               → closes fine, no liquidation, trade OK

Reality:        short perp at 3400, liq at 3450
               → price hit 3520 INTRABAR, liquidated at 3450
               → you never saw the close. The trade is gone.
```

```pseudocode
function simulateCandle(position, candle, config) -> Outcome {
    // Adverse direction for a SHORT is UP
    if (position.isShort && candle.high >= position.liquidationPrice) {
        return Outcome.LIQUIDATED
    }
    if (position.isLong  && candle.low  <= position.liquidationPrice) {
        return Outcome.LIQUIDATED
    }
    // Otherwise evaluate on close for PnL
    return evaluateClose(position, candle)
}
```

A backtest that ignores this will overstate survival rate and report a profitable strategy
that would have been liquidated repeatedly in practice. Assume 1-minute candles are already
optimistic; real intrabar wicks are worse.

### 9.4 Metrics before going live

| Metric | Gate |
|---|---|
| Net ROI after all costs | **> 0** — hard gate, non-negotiable |
| Sharpe (annualized) | > 1.0 |
| Max drawdown | < 15% |
| Liquidation count in sim | **0** — any liquidation means the sizing is wrong |
| Profit concentration | Top 5% of trades < 40% of total PnL |
| Trade count | ≥ 200 for statistical validity |
| Performance vs. always-on | Must beat passive hold — if the bot is worse than just holding, the model adds nothing |

That last row is the honest benchmark. A funding strategy that underperforms simply holding
the delta-neutral position has failed, no matter how the Sharpe looks.

### 9.5 Success criteria to proceed to paper trading

1. Net positive after costs, ≥ 200 simulated trades
2. Zero simulated liquidations
3. Positive out-of-sample on a held-out period
4. Max drawdown < 15%
5. Results not driven by 1–2 outliers

If any fail, fix the model or abandon. Do not proceed and hope live differs favorably.

---

## 10. Delivery Sequence

### Weeks 1–2 — Paper trading, no capital

- Backtester complete and passing §9.4 gates
- Live data pipeline against real venue APIs
- Jev integration with full JSONL logging
- **Both venue connections as simulated** — no order capability in code at all
- Run 24/7; accumulate ≥ 200 logged decisions

**Exit criteria:** zero unhandled errors over 7 days; 200+ decisions logged; calibration
table produced; every entry signal hand-checked against a manual decision.

### Weeks 3–4 — Live, minimum size

- `$5,000` notional max, one position, one symbol (ETH)
- Real orders, real circuit breakers armed
- All §7 breakers enabled from the first trade
- Daily manual reconciliation of positions

**Exit criteria:** ≥ 20 completed live positions; realized ROI within ±30% of backtest;
zero breaker trips; no leg-failure incidents unresolved.

### Weeks 5–8 — Calibration and tuning

- Expand to 2–3 positions, `$15,000` cap
- Recompute calibration with live data; adjust confidence gates
- Test `invalidators` — do they fire when they should?
- Add SOL as second asset if ETH works

**Exit criteria:** ECE < 0.10; Brier < 0.21; live Sharpe > 0.8; confidence buckets
monotonic.

### Week 9+ — Scaling decision

Scale only if calibration holds. The go/no-go is **not** "did we make money" — it is
"does the confidence score predict outcomes." If confidence is uninformative, the model
adds nothing over a threshold rule, and scale is unjustified regardless of PnL.

---

## 11. Assumptions & Unknowns

**Assumed (verify before building):**

- Funding rates mean-revert over 12–48h
- Perpetual premium over spot roughly predicts funding persistence
- 2–3× leverage is conservative for ETH-sized positions
- ETH is sufficiently liquid that 10 bps slippage holds at $50k
- Venue APIs are stable enough to poll at 2s intervals
- Funding events occur on predictable schedules

**Unknown — these will change the design:**

| Unknown | Impact | Resolution |
|---|---|---|
| Actual frequency of funding > 95th percentile | Determines trade count and whether the strategy is viable at all | Backtest first |
| Funding persistence at extremes | Determines whether the `hours_persistent` gate helps or just reduces trades | Backtest |
| Jev calibration | Determines whether Jev earns its cost at all | Live calibration weeks 5–8 |
| Venue liquidation mechanics | Assumed 2–3× is safe; unverified on each venue | Read venue docs, then stress test |
| Cross-venue withdrawal latency | Assumed negligible; materially affects the naked window | Measure in paper trading |
| Whether favorable funding is already arbitraged away | If professionals front-run extremes, retail cannot capture it | Backtest against published searcher results |

**Explicitly out of scope:** multi-exchange arbitrage, order book modelling, market making,
HFT, cross-collateral optimization, governance participation.

---

## 12. Success Metrics

### Profitability

| Metric | Target |
|---|---|
| Net ROI after all costs | > 8% annualized |
| Sharpe | > 1.0 |
| Max drawdown | < 15% |
| Win rate | > 65% (carry strategies should win often and small) |
| Avg win / avg loss | > 3.0 (many small wins, rare contained losses) |
| Capital efficiency | Beat passive delta-neutral hold |

### Model quality

| Metric | Target | Meaning |
|---|---|---|
| ECE | < 0.10 | Confidence tracks reality |
| Brier score | < 0.21 | Better than a constant 0.7 forecast |
| Bucket monotonicity | Strict | Higher confidence → higher actual win rate |
| Duration error | MAPE < 40% | `predicted_duration_hours` is useful |
| ROI forecast error | Within ±50% | `predicted_roi_pct` is directional, not precise |

### Operational

| Metric | Target |
|---|---|
| Jev p95 latency | < 1500 ms |
| Jev failure rate | < 1% |
| Leg-failure rate | < 0.5% |
| Margin monitor uptime | 99.9% |
| Unplanned position hours | 0 |

### The honest success criterion

The strategy succeeds if **confidence is informative and net ROI is positive after all
costs.**

It is not: making money in isolation (could be luck or a favorable regime), or the bot
running without errors (a bot that faithfully loses money has still failed).

If after 200 live trades the calibration curve is flat — meaning confidence does not predict
outcomes — then Jev is decoration, the correct action is to strip it out, and a simple
threshold rule on `zscore` will do the same job for a fraction of the latency and cost. That
is a valid and useful outcome of this project.
