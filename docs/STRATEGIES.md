# Strategies

An honest assessment of what liquidation strategies are available to this bot, what each
requires, and which are worth building.

Last verified against Base mainnet at block **52,214,428** (2026-10-05).

---

## What the bot is trying to do

Strip away the naming and the strategy is: **find accounts on Base Aave whose health factor
has fallen below 1.0, seize their collateral at the liquidation bonus, swap it back into the
debt asset to repay, pocket the spread.**

That is a liquidation searcher. It is a legitimate business. It is also, as currently
implemented, unprofitable — not because the strategy is wrong, but because the bot is missing
the three things that determine whether it wins.

---

## Verified on-chain facts

Everything in this table was read from Base mainnet, not recalled from documentation.

| Item | Value |
|---|---|
| Chain | Base, chainId `0x2105` (8453) |
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| PoolConfigurator | `0x5731a04B1E775f0fdd454Bf70f3335886e9A96be` |
| AddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| Price oracle | `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` |
| `POOL_REVISION` | **11** → Aave **v3.1+** |
| Oracle decimals | 8 (`BASE_CURRENCY_UNIT = 1e8`) |
| Reserves listed | 15 |
| Public RPC `eth_getLogs` limit | **500 blocks** |

### Reserve parameters

Decoded from the bit-packed `getConfiguration()`. Values are `1e4`-scaled and `bonus` is
stored as a *multiplier*, so `10500` means 105% of debt seized, i.e. a 5% bonus.

| Asset | maxLTV | liqThreshold | bonus | decimals | address |
|---|---|---|---|---|---|
| WETH | 80% | 83% | 5% | 18 | `0x4200...0006` |
| USDC | 75% | 78% | 5% | 6 | `0x8335...2913` |
| cbBTC | 73% | 78% | 7.5% | 8 | `0xcbb7...33bf` |
| AERO | 0% | 0% | 0% | — | `0x9401...8631` |

AERO reading 0% across the board means it is **not a borrowable collateral reserve** — it is
listed but frozen for borrowing. It will never appear as a liquidation collateral.

### Unverified assumptions

These revert on the deployed PoolConfigurator and are carried from Aave v3.0 documentation.
**Confirm before relying on any of them.**

- `MAX_LIQUIDATION_CLOSE_FACTOR` — assumed 100%
- `DEFAULT_LIQUIDATION_CLOSE_FACTOR` — assumed 50%
- `CLOSE_FACTOR_HF_THRESHOLD` — assumed 0.95 (below this HF, 100% close factor applies)
- `LIQUIDATION_PROTOCOL_FEE` — assumed 10% of the seized collateral

v3.1 changed the dynamic-bonus mechanism, so these may all have shifted. They are the single
highest-priority thing to verify, because every profit figure depends on them.

---

## Why the current build loses money

Four independent problems. The first three are correctness bugs. The fourth is structural.

### 1. The classifier never calls the API

`askJev()` in `src/jev/classifier.ts:34` does not make a network request.
`getClassifier()` exists only to throw if `TYPESAFE_API_KEY` is missing; the function body then
computes urgency from an LTV ratio, profitability from a profit margin, and **hardcodes
`is_safe = 0.8`** at line 44.

So "REAL" mode is byte-for-byte the same arithmetic as `askJevMock`, minus the randomness. The
dashboard's `MOCK (no API key)` vs `REAL` label is currently a lie about what is executing.

Every value this produces is exactly computable from on-chain state. That is the point of not
using an LLM.

### 2. The gates re-filter the classifier's own output

`src/execution/risk-gates.ts` thresholds urgency, profitability, and safety — the same three
numbers the classifier just produced. The classifier and the gate filter are measuring the
identical quantity twice, which means the AI layer is decorative.

There is also a genuine bug here: `ltvImprovement` at line 75 computes
`ltv_close_factor * (profit_usd / debt_usd_value)`, which is a ratio of a *dollar* profit to a
*dollar* debt. That is not an LTV comparison, so gate 6 passes unconditionally.

### 3. Liquidation eligibility is random noise

`ltv_current` is randomized to 0.75–0.90 in `generateMockLiquidationState`, then compared
against `ltv_liquidation_threshold: 0.85`. But the balances are hardcoded: $250,000 collateral,
$200,000 debt.

With WETH's real liquidation threshold of 83%, the true health factor of that position is:

```
HF = (250,000 × 0.83) / 200,000 = 1.0375
```

**1.04 — comfortably solvent.** The mock can liquidate accounts that are nowhere near
liquidatable, and skip ones that are. The field that decides execution is decoupled from the
balances that would actually determine it.

### 4. The profit model omits the costs that matter

`profit_after_gas` is `debt_usd_value × liquidation_bonus`, with the mock using an 8% bonus
against the real 5%. It ignores the close factor entirely, ignores the protocol fee, and never
accounts for the swap.

On the mock's own $200,000 WETH/USDC position, with real parameters:

| Line | Amount |
|---|---|
| Debt closed (50% close factor) | $100,000 |
| Collateral seized (1.05×) | $105,000 |
| Gross bonus | **$5,000** |
| Protocol fee (10%) | −$500 |
| Swap + slippage (est.) | −$250 |
| Gas | −$90 |
| **Net per position** | **~$4,160** |

So ~$4k, not the ~$16k the mock implies. That is still real money. The problem is volume — see
below.

---

## The structural problem: polling cannot win

**This is the load-bearing issue, and it is not fixable by better analysis.**

Liquidations are not discovered, they are contested. The moment an oracle price moves, dozens
of accounts cross HF < 1.0 simultaneously and every searcher in the mempool converges on the
same block. The race is decided by *latency*, not by how good your opportunity scoring is.

This bot's current shape:

- polls on a `setTimeout(1000)` between opportunities (`src/index.ts:83`)
- over a **public** RPC
- would send an ordinary transaction into the public mempool

Against that field it is up against firms running private tx endpoints, Jito bundles,
MEV-share, and Aave's own keeper. A public-mempool bot loses essentially 100% of contested
liquidations.

The `is_safe` gate is nominally the frontrun/sandwich check, but competitive risk is only
knowable from **mempool observation** — pending transactions targeting the same account —
which nothing in this codebase reads.

**Without private ordering, expected value is negative once infra costs are counted.**

---

## Strategy options

### Option A — Liquidation searcher, done properly

The current strategy, built correctly. Requires:

- [ ] Low-latency dedicated RPC (Alchemy / QuickNode / Blaze tier, not public)
- [ ] Private tx or bundle submission (bloXroute, Alchemy private mempool, Jito)
- [ ] Pre-computed calldata, pre-funded gas, pre-approved debt token
- [ ] Real Aave v3.1 params: close factor, protocol fee, dynamic bonus
- [ ] Capital model: ETH for gas + debt asset sized to close factor
- [ ] Swap execution with explicit slippage budgeting
- [ ] Health factor computed from `getUserAccountData`, not a random number

**Edge:** latency, capital, and private ordering. The classifier contributes almost nothing.
**Effort:** high. **Realistic net:** positive only if you are in the top few bidders.

### Option B — Batch/statistical liquidator

Instead of racing, accumulate: watch accounts, and when HF < 1.0, liquidate only large positions
where the ~$4k spread justifies worse latency. Fewer contests, far less competition, much
lower ceiling.

**Edge:** you compete for the *large* positions where others' latency advantage matters less.
**Effort:** medium. **Realistic net:** lower volume, higher win rate. Best risk-adjusted
starting point.

### Option C — Not a liquidation bot at all

The finding from this document is that the AI layer is decorative. If the goal is to *use* the
Jev model in a way that genuinely earns money, liquidation scoring is the wrong application —
the decisions are deterministic and the edge is infrastructural.

Better fits for an LLM classifier in DeFi:
- Narrative-driven risk: classifying governance proposals, token unlock events, or social
  sentiment into tradeable signals
- Opportunity triage across many protocols, where the model summarizes unstructured context
- Post-trade analysis and strategy mining over historical fills

**Edge:** genuinely non-deterministic inputs. **Effort:** varies.

### Option D — Simulation and research tool

Own the analysis layer: a backtester over historical Aave state that answers "what would a
latency-advantaged liquidator have earned?" using real reserves and real gas.

This is genuinely useful, has no capital requirement, and produces the data needed to decide
whether Option A or B is worth attempting at all.

**Edge:** none directly, but it de-risks A/B. **Effort:** low-medium.

---

## Recommendation

**Option D first, then Option B.**

A backtester tells you two things nothing else will: the real frequency of liquidatable
opportunities on Base, and the real profit per opportunity at realistic parameters. If the
answer is "4 opportunities a week at $4k each," no amount of infrastructure work pays for
itself, and that is a fact worth knowing before spending months.

If the backtest shows adequate volume, build Option B with a low-latency RPC. Private
submission is required before Option A makes sense.

Meanwhile, fix the correctness bugs in Option A's current form regardless of strategy: the
classifier that lies about calling an API, the unconditional gate 6, and the disconnected
random health factor. Those are wrong in every scenario.

---

## Honest status summary

| Component | Claimed | Actual |
|---|---|---|
| Jev classifier | AI scoring | local arithmetic, API never called |
| Health factor | Aave state | `Math.random()` in a range |
| Profit | actionable PnL | ~4× optimistic, ignores close factor and fees |
| Race for liquidations | n/a | public RPC, public mempool, 1s poll |
| Bot loop | daemon | runs 5 iterations, exits |
| Target venue | largest pool | Aave V3 is 8.3× smaller than Morpho Blue on Base |

---

## See also

[STRATEGY-LANDSCAPE.md](./STRATEGY-LANDSCAPE.md) — surveys alternatives (delta-neutral carry,
concentrated LP, vault curation) and argues that concentrated LP is the only one on the list
where a model's output maps directly to an executable parameter.
