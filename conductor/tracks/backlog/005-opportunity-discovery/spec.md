# 005 Opportunity Discovery Radar — Spec

## Strategy

**Paper-only radar: find trade opportunities regardless of whether we can execute them yet.**

- **Venue:** read-only, multi-chain (the 14 Morpho API chains; DEX reads where factories are known — see `docs/multichain-research.md`).
- **Method:** one shared JSONL paper log per strategy — candidate counts, sizes, cadence, source citation. No gates that require executability.
- **Jev role:** none in the measurement path. A strategy may use a classifier later, in its graduating track; here evidence is deterministic reads only.
- **No execution, no server, no dashboard, no database.** Scripts + flat logs only.

---

## Hard Constraints

1. **Nothing signs, nothing broadcasts.** No private keys in scope; scripts are read-only by construction.
2. **Every logged opportunity cites its source** (API row, pool state, block number). No synthetic rows, no mock fills — same honesty rule as 004.
3. **Discovery ignores executability.** Thin liquidity, missing flash venue, cross-chain friction are *annotations*, not filters. Realizability is judged at graduation, not during discovery.
4. **Rate-limit discipline.** Public RPC + 750 req/min Morpho API cap; cache aggressively, reuse `src/scan.ts` discovery where possible.
5. **A strategy without 7 days of paper evidence cannot graduate.** Opinion does not promote; logs do.

---

## Strategy Catalog

### Existing (already in this repo's orbit — measure before judging)

- **S1 — Morpho Blue liquidation racing (current).** Baseline exists: ~1,690 candidates/cycle, 0 survive exit-liquidity. Radar question: which collateral families and chains produce the *largest raw seize* before the gate, and is the gate or the venue the problem?
- **S2 — At-risk wave watch (HF 0.98–1.30).** The watchlist already scans this band for pre-computed verdicts. Radar question: do waves arrive in predictable clusters (oracle-lag waves, R2 in `docs/system-one-redesign.md`)? Log wave size/timing per market.
- **S3 — Recursive leverage / rate spread (yield-spread lineage).** A prior `yield-spread` process exists (currently stopped). Radar question: which markets sustain borrow-vs-staking spreads net of fees over 7 days?
- **S4 — Bad-debt / dust cleanup (bad-debt-cleanup lineage).** Prior process logs exist. Radar question: is there a steady-state set of sub-threshold positions any keeper leaves behind?

### New (prospect from zero, cheapest reads first)

- **N1 — Multi-protocol liquidation scan.** Same racing model, new venues: Aave V3, Compound Comet, Spark, Moonwell, Euler v2, Silo. Start with one: largest-TVL protocol we don't scan. Question: raw liquidatable count/size vs Morpho.
- **N2 — Depeg / discount capture.** Collateral trading below redemption (PT tranches, LRTs, stable variants post-stress). Reads: DEX spot vs oracle/redemption. Question: frequency and depth of >2% discounts on >$10K depth.
- **N3 — DEX triangular / multi-hop arb (paper).** Within one chain, quote triangle loops on known factories (Uniswap V3, Aerodrome/Velodrome). Question: quotes-positive loop frequency net of gas — paper only, no racing infra.
- **N4 — Oracle-lag wave prediction.** Time series of oracle age + dex/oracle spread + collateral drawdown per market (the R2 proposal). Question: does spread widen *before* HF crosses? Lead-time distribution.
- **N5 — Incentive / rewards harvest.** Morpho rewards, reserve auctions, governance distributions. Question: claimable-value cadence vs gas on chains we already read.
- **N6 — Redemption / auction discounts.** Dutch/redemption mechanisms (e.g. discounted unwinds, collateral auctions) offering below-market fills. Question: fill frequency and discount depth.

Out of scope for this track: MEV sandwiching, CEX-dependent basis/funding (no CEX venue in this repo), anything requiring new private infra before its first paper log.

---

## Acceptance Criteria

### Stage 1 — Radar harness

- [ ] Shared JSONL paper-log schema (`strategy, chain, block, candidate_id, size_usd, source, annotations`) + `npm run radar -- <strategy>` runner reusing `src/scan.ts` / `src/lib/*` reads
- [ ] S1 + S2 logging within existing scan loop at zero extra RPC cost (piggyback, cached reads only)

### Stage 2 — Per-strategy prospecting (cheapest first: S1–S4, N4, N1, N2, N5, N3, N6)

- [ ] Each attempted strategy: 7-day paper log OR written kill note (what read blocked it, e.g. no factory, no API)
- [ ] Kill notes are first-class output — a fast, evidenced "no" beats an unmeasured "maybe"

### Stage 3 — Ranking + graduation

- [ ] Ranked table: frequency × median size × data confidence, with log pointers
- [ ] Each strategy ends in one of: **graduate** (active-track proposal), **park** (revisit trigger + date), **kill** (evidence summary)
- [ ] At least one graduate proposal or all-killed with rationale — "measured nothing" is failure, "measured zero" is success

---

## Data Pipeline

| Source | Method | Cadence |
|---|---|---|
| Morpho positions/markets | GraphQL API (existing `src/scan.ts`) | piggyback current loop |
| On-chain oracle/pool state | `eth_call` via `src/lib/prices.ts`, cached | per strategy need, TTL'd |
| New-protocol positions | protocol subgraphs/APIs (one per strategy) | daily batch ok |
| DEX quotes (N3) | factory `getPool` + slot/liquidity reads | sampled, not per-block |

---

## Success Gate

**Ranked table + graduation decisions from 7-day paper evidence.** No strategy moves toward capital on narrative; the graduating track re-imposes realizability gates (the exact thing this track suspends).
