# DeFi Strategy Landscape for Base

A survey of strategies available on Base, assessed against one question: **where does a
predictive model actually earn its keep?**

Data from DefiLlama and verified on-chain reads, 2026-10-05. On-chain values re-verified at
Base block 52,214,428.

Related: [STRATEGIES.md](./STRATEGIES.md) covers the liquidation strategy in depth, including
why the current build loses money and the on-chain parameter audit.

---

## The uncomfortable framing

There is a tension running through every strategy below:

**Strategies easy enough to execute programmatically don't need a model. Strategies that
genuinely need a model are hard to execute programmatically.**

Deterministic strategies — funding-rate arbitrage, basis trades, liquidations — have
mathematically derivable edge. An LLM adds latency and cost to a decision that a spreadsheet
already gets right.

Non-deterministic strategies — narrative trading, curator risk assessment, governance event
scoring — have real information edges, but the signal arrives as text, not as a number a
contract can consume.

So the honest question is not "which strategy is most profitable." It's **"which strategy
converts a model's output into executable value without a human in the loop."**

---

## Base chain context

| Metric | Value |
|---|---|
| Total TVL | $6.44B |
| Stablecoin mcap | $5.19B (83.7% USDC) |
| DEX volume 24h | $1.11B |
| Perp volume 24h | $216.7M |
| Perp open interest | $72.3M |
| Chain fees 24h | $55.3K |
| Active addresses 24h | 289,176 |

Chain fees of $55K/day against $1.1B of DEX volume means **gas is essentially free**. This
matters: it removes the main reason small accounts don't compete on-chain. Latency, not gas,
is the binding constraint on every latency-sensitive strategy here.

### Where the money actually is

| Protocol | Type | Base TVL | Fees 24h | Revenue 24h |
|---|---|---|---|---|
| Morpho Blue | Lending | $4.565B | $271,707 | $0 |
| Uniswap | DEX | $512M | — | — |
| Aave V3 | Lending | $566M | $32,725 | $3,888 |
| Aerodrome | DEX | $399M | $304,111 | $189,915 |
| Spark | Lending | $335M | — | — |

Two observations:

**Morpho Blue is 71% of Base TVL** — 8.3× Aave V3 on a comparable fee/TVL rate. The current bot
targets the smallest major lending book on the chain.

**Morpho Blue takes zero protocol revenue.** It is pure pass-through. Aave V3 nets $3,888/day.
Liquidation bonuses are paid out of borrower interest income, not protocol revenue — so the
fee pool funding liquidator rewards scales with borrower activity, and Morpho's is 8× larger.

### Reference yields (USDC, gross)

| Source | APY | TVL |
|---|---|---|
| Morpho GTUSDCP | 4.42% | $414M |
| Morpho STEAKUSDC | 4.41% | $334M |
| Morpho SPARKUSDC | 3.96% | $334M |
| Morpho CSCBUSDC | 4.02% | $33M |
| Veranta USDC | 18.44% | $10M |

The Morpho vaults cluster tightly at 4–4.4% across $1B+ of TVL. That consistency is what
makes them usable as a carry leg.

Veranta's 18.44% on $10M is an outlier roughly 4× the Morpho rate. That gap is either
mispriced risk or a mislabelled APY. Underwriting it means understanding what Veranta is and
who bears the credit risk — not reading a yield aggregator.

---

## Strategy 1 — Delta-neutral carry

**What it is.** Supply USDC to a lending market at ~4.4%, short the same notional on a perp.
Collect the spread, ignore direction.

**Where the data points.** Morpho vaults at 4.4% on $414M+ of stable TVL. Perp OI of $72.3M on
Base with Veranta ($1.14B reported OI) and SynFutures ($516M) as the deepest venues.

**Why it works.** Funding rates mean-revert; the carry is positive when borrow-side rates
exceed perp funding. With gas at $0.02, the breakeven is low.

**Where the model fits.** Nowhere. This is arithmetic. Funding is a number; the spread is
subtraction.

**Risks.** Funding flips negative and the carry inverts. The perp leg liquidates on a price
move regardless of the lending leg being fine. Veranta's headline APY carries credit risk
that a delta-neutral hedge does *not* neutralize — that's the trap.

**Verdict.** Real, low-complexity money. Explicitly a non-AI strategy. Build it to learn the
stack, don't build it to use Jev.

---

## Strategy 2 — Concentrated liquidity management

**What it is.** Hold a narrow Uniswap v4 or Aerodrome Slipstream position, then predict the
price range and rebalance around it.

**Where the data points.** DefiLlama reports gross LP APYs on Base well above lending rates:
Uniswap V3 WETH-USDC at 35.4% on $162M, Aerodrome Slipstream WETH-USDC at 83.7% on $10M,
USDC-cbBTC at 291% on $7M.

**Why it works.** Fee generation in a concentrated range is a function of where price *goes*,
not where it is.

**Where the model fits — and this is the real fit.** Range selection is a genuine forecasting
problem with a clean, supervised, measurable target. Predict realized volatility and drift
over a holding window, size the range to your confidence interval, rebalance on breach. The
model's output maps directly to a tick range. This is the most defensible use of a predictive
model in this entire document.

**Risks.** The headline APYs are gross and range-dependent. A 291% APY on a $7M pool is a very
tight range that goes out of range quickly — the number is real but not harvestable passively.
Impermanent loss can exceed fees. Every rebalance pays gas and slippage.

**Verdict.** Best model fit on this list. Also the most operationally demanding: it requires a
position manager, not a one-shot executor.

---

## Strategy 3 — Morpho Blue liquidations

**What it is.** The current strategy, pointed at a 8× larger pool.

**Where the data points.** $4.565B TVL, $271.7k/day fees, 15 reserves on Aave plus Morpho's own
market set. Morpho Blue is deployed at
`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` on Base (verified, 15,623 bytes).

**Why it works.** Same mechanics as Aave: repay debt, seize collateral at the LLTV bonus.

**Where the model fits.** Nowhere, same as Aave. Liquidation eligibility is exactly computable
from `idToMarketParams` + oracle prices.

**Why the switch is worth it anyway.** Bigger fee pool, and Morpho Blue's isolated per-market
LLTV changes the risk profile — a bad market fails alone rather than contaminating a shared
pool. That compartmentalization is a genuine structural advantage for a small liquidator.

**A real obstacle I hit.** Morpho Blue market IDs are `keccak256`-derived, **not sequential**.
Probing IDs 1–4000 returned only zeros. Enumerating markets requires the Morpho subgraph or
full-history event log scans — and the public Base RPC caps `eth_getLogs` at **500 blocks**
(verified by hitting that limit). Market discovery is the actual engineering problem here, not
liquidation.

**Verdict.** Same strategy, better venue, harder discovery. Latency requirements are unchanged.

---

## Strategy 4 — Vault risk curation

**What it is.** Allocate capital across lending vaults based on assessed risk. This is the
job description of Steakhouse ($1.10B), Gauntlet ($614M), Clearstar ($89M), Aera ($81M), and
Grove ($189M) — all Base-active, all collectively >$2B.

**Where the data points.** Steakhouse is down **-28.14% over 30 days** on $1.10B. Curators
lose real money, which means risk assessment has genuine signal and genuine failure modes.

**Why it works.** A vault's risk lives in unstructured text: LLTV headroom, oracle design,
curator track record, governance assumptions, market concentration. None of it is a field on
chain.

**Where the model fits — the strongest conceptual fit.** This is a read-and-judge task over
prose and on-chain state. It is what language models are actually good at, and there is no
arithmetic shortcut that replaces it.

**Risks.** Slower than latency-arbitrage; edge decays as the market standardizes and curators
publish their own risk frameworks. Underwriting opaque vaults is a slow way to lose capital.

**Verdict.** Best conceptual fit for AI. Weakest fit for an autonomous executor — the output is
a judgment, not a transaction.

---

## Strategy 5 — L2 oracle and sequencer risk

**What it is.** Base is an L2. Chainlink L2 sequencer uptime feeds and grace periods create
windows where oracle staleness is exploitable, in both directions.

**Why it works.** L2 oracle failure modes are a documented, recurring class.

**Risks.** This is adversarial security work with real capital at risk. Direction matters
enormously — being on the wrong side of a sequencer-window trade is a total loss, not a
drawdown.

**Verdict.** Skip unless someone on the team has L2 oracle security experience. Not a
first project.

---

## Strategy 6 — Narrative and event-driven trading

**What it is.** Trade governance proposals, token unlocks, listings, and social narratives.

**Where the model fits.** Maximum. These inputs are inherently textual and non-deterministic.

**Risks.** Execution is the hard part — the signal arrives as prose and must become a
transaction with a size and a timing. This is a human-in-the-loop business wearing an
autonomous-bot hat. Highest ceiling, lowest automation ratio.

---

## Comparison

| Strategy | Model fit | Execution determinism | Capital | Latency sensitivity |
|---|---|---|---|---|
| Delta-neutral carry | None | Fully automatic | High | None |
| Concentrated LP | **Strong** | Automatic | Medium | Medium |
| Morpho liquidations | None | Fully automatic | Medium | **Extreme** |
| Vault risk curation | **Strong** | Human judgment | High | None |
| L2 oracle risk | Weak | Fully automatic | High | Extreme |
| Narrative trading | **Strong** | Human judgment | Medium | High |

The two strategies that genuinely benefit from a model — concentrated LP and vault curation —
are precisely the two that a contract cannot consume the output of.

---

## Recommendation

**Build the concentrated LP range manager next.**

1. **It is the only strategy here where a model's output maps directly to an executable
   parameter** — a tick range.
2. **Base LP APYs genuinely exceed lending rates**, so the opportunity is real before
   impermanent loss.
3. **It reuses this entire codebase.** The event emitter, dashboard, risk gates, and paper
   executor are all exactly the right shape. A liquidation pipeline with simulated fills
   becomes an LP pipeline with simulated rebalances.
4. **Latency is not the binding constraint,** so it does not require private infrastructure to
   start.
5. **It is measurable.** A backtest on historical candles with realistic fees gives a real
   answer about whether the model has edge — which is the question this project keeps dodging.

Concretely, the first milestone is a backtester: historical Base price data, a fee model, a
range-selection policy, and out-of-sample evaluation of net return after impermanent loss and
gas. No capital, no risk, and it produces the evidence needed to decide anything else on this
list.

Keep the liquidation work as-is. It is a good pipeline and it correctly reports that it is
simulating. It is not, at current infrastructure, a business.

If the goal is specifically to exercise Jev in production, **Strategy 4 (vault risk curation)**
is the honest use. Just accept it is a research product, not an autonomous bot.
