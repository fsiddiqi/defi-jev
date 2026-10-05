# Backlog

Accepted work that is not the current priority. Every track here should have a written spec
and a reason it is waiting.

## Contents

| Track | Status | Why waiting |
|---|---|---|
| [002-observability-alerting](./002-observability-alerting/) | backlog | Partially shipped in `b1ec7e7`. Remaining work is observability depth, not a blocker for the active track. |
| [003-funding-harvesting](./003-funding-harvesting/) | backlog | Spec complete, Stage 1 unblocked. Paused because the measured ceiling is 6.57-7.39%/yr on committed capital, which is a thin return for the system's complexity. |

## Why 002 is backlog rather than closed

Most of this track shipped: the SSE dashboard, Telegram alerts, pino file transport, and
`/api/health` all exist. It is not finished because:

- `src/metrics.ts` does not exist — `prom-client` is a dependency but is never imported
- No `/metrics` endpoint is exposed
- No tests for the dashboard SSE path or Telegram message formatting
- No Telegram periodic digest
- Log rotation not implemented (the file transport grows unbounded)
- `plan.md` checkboxes are stale and contradict the shipped code

The honest status is "mostly done, partially unfinished", which is what `backlog` is for.

## Entry criteria

Work is understood well enough to describe but is not the highest-value use of time right
now. Record *why* it is waiting so the decision can be revisited rather than relitigated.

## Why 003 is backlog

The spec is finished and the Stage 1 backtester is not blocked on anything. Work stopped
after the primer established the return ceiling, because that ceiling is the first thing
worth knowing and it argues for a cheap standalone backtest before building the full pipeline.

- Funding is `1.125e-5`/hour measured, which is 9.86%/yr annualized **on perp notional**
- Capital committed is spot *plus* margin, so return on capital is `f / (1 + 1/L)` —
  **6.57% at 2x, 7.39% at 3x**, before costs
- A 30 bps round trip takes **267 hours (~11 days)** of holding to recover
- §12's previous ">8% annualized" target was above that ceiling and has been removed

So the open question is not "can this be built" but "does the agent beat simply holding the
position." That question is answerable with a backtest and a spreadsheet, without the Jev
integration, the Postgres history store, or the execution layer.

**Reactivation gate:** run the Stage 1 backtest standalone first. If net ROI after costs is
comfortably above passive hold, continue to Stage 2. If it is marginal, the honest move is to
leave the strategy in backlog and put the effort elsewhere — §12 already names flat calibration
as a valid outcome, and a thin ceiling makes "remove the agent" an equally valid one.

Two inputs remain unmeasured and would change the Stage 2 decision: real OpenRouter per-call
cost, and the three undefined sizing parameters in §3.1.
