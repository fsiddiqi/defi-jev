# System One / System Two: repositioning the classifier

Date: 2026-10-08. Status: proposal (the ledger that measures it is implemented —
see `508b503`).

## Diagnosis

The pipeline has two thinking systems:

- **System Two** — deterministic gates, `profit.ts` economics, `PoolQuoter`
  state-overridden `eth_call`, the contract's on-chain `minProfit`. Exact,
  cheap, testable, and the ONLY thing that has ever protected capital.
- **System One** — the TypeSafe/Jev classifier. Fast, narrative, tolerant of
  ambiguity.

The bug: System One was put in the **signing path as an authorizer and as a
rules-executor**. Its prompt rule #4 (REALIZABILITY) restated arithmetic the
code already computes, and the live evidence (2026-10-08, RSS/USDC): a
$1.4M "seize" against a $1.65 pool with a dex price 36,900x below the oracle
was handed to the classifier for 2,465 tokens — what two deterministic `if`
statements now block for free. The codebase already knew this about the model:
`gates.ts` carries the comment *"the classifier proved unreliable at applying
this rule to raw pairs of numbers"* — which is precisely why
`dataIntegrityGate` runs before it.

Meanwhile its genuine strengths go unused: judgment over ambiguous
*relationships*, arbitration among near-equals, and forward-looking pattern
recognition over aggregated state.

## Principles

1. **System Two excludes; System One only ranks or flags among the survivors.**
   Hard, cheap, exact checks remove the impossible; the classifier never
   authorizes money and never vetoes on vibes without a reasoning code.
2. **Feed it distilled, decision-relevant state — never raw arithmetic.**
   It judges stories ("this market is about to unwind"), not ratios.
3. **Every verdict is falsifiable against System Two ground truth.** The
   One-vs-Two ledger (`jevJudged`, `jevExecuteRefusedByOnChain`,
   `jevExecuteSettled`, plus the per-verdict audit line: cap, dex/oracle
   ratio, profit, rules-viable) turns "is it worth it?" from opinion into a
   measured rate.

## Proposed roles, in value order

### R1 — Dispatch arbitration (highest, most concrete)
When ≥2 mechanically-clean, EXECUTE-eligible targets compete for one slot
(`MAX_CONCURRENT`, gas budget, or latency), ask System One to pick the order:
competition pressure, cascade position, oracle-age decay, block-space
congestion. This is genuinely non-arithmetic — the tie-break is where racing
bots actually differ — and it can be scored immediately against realized
outcomes. Cost: one batched call per contested cycle.

### R2 — Oracle-lag wave detection (the "leak")
Per-market time series of oracle age, dex/oracle spread, and collateral
drawdown already exist in the scan. One batched question per idle cycle:
*"which markets are about to produce a wave of liquidations, and when?"* This
is prediction, not classification — it pre-positions the watchlist before HF
crosses, which the current per-candidate role structurally cannot do. This is
the only proposed role that generates alpha rather than filtering loss.

### R3 — Collateral trap triage ("One proposes rules, Two enforces them")
For collateral and venues the registry has not verified, System One drafts an
adversarial sanity opinion (transfer-tax, honeypot, paused-oracle smells) →
feeds a `denyPending` list. Anything it flags that proves right becomes a
deterministic gate or registry entry — the classifier writes the rules, the
gates run them forever, for free. Command shape: `npm run triage -- <token>`.

### R4 — Narrative audit trail (keep what exists)
`reasoningCode`/`sanity` labels and the feed's decision column are already the
UI's main value. Keep, and let the new audit line show the mechanical facts
each verdict was measured against.

## Non-goals

- Never sign, send, or choose gas. Authorization stays: rules → quote →
  simulate → on-chain `minProfit`.
- Never do arithmetic (that is what gates are for; `preJevGates` +
  `realizabilityGate` run first, always).
- Never accept a verdict without a reasoning code that names a checkable claim.

## Decision rule (kill switch for the execution-path role)

Over a window of ~200 judged candidates: if System One never surfaces an
EXECUTE that (a) survives the on-chain quote and simulation and (b) a
rules-only policy would have missed, its execution-path role is redundant —
demote to advisory (`MIN_JEV_EXECUTE_PROB=0`), keep R2/R4. Current score:
0 EXECUTE of 1,696 judged; its one live decision duplicated the new gates.

## Cost impact

Stripping rules out of the prompt's job means fewer candidates reach the
model (junk never gets sent); R1 is contingent (only on contested cycles);
R2 adds at most one batched call per cycle under the existing
`JEV_MIN_INTERVAL_MS` throttle. Net token spend: flat to lower than the
current ~$0.25/day ceiling.
