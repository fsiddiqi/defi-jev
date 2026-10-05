# Backlog

Accepted work that is not the current priority. Every track here should have a written spec
and a reason it is waiting.

## Contents

| Track | Status | Why waiting |
|---|---|---|
| [002-observability-alerting](./002-observability-alerting/) | backlog | Partially shipped in `b1ec7e7`. Remaining work is observability depth, not a blocker for the active track. |

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
