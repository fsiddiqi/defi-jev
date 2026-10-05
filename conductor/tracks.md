# Conductor Tracks

Development tracks for defi-jev, organised by state. Index of record:
[tracks/](tracks/)

## Structure

Tracks live in one of four state folders. A track's location is its status — there is no
separate status field to keep in sync.

```
conductor/tracks/
├── active/     in progress (max 1)
├── backlog/    understood, not current priority
├── blocked/    cannot proceed; needs an external unblock
└── closed/     complete; kept for history, not maintained
```

## Active

| Track | Status | Priority | Summary |
|---|---|---|---|
| [003-funding-harvesting](tracks/active/003-funding-harvesting/) | 🟢 active | P1 | Delta-neutral funding carry on Hyperliquid |

Backtester-first. Phase 2.1 is a blocking gate: it must beat passive delta-neutral hold
(~9.86%/yr gross) before any execution code is written. Replaces the `phase-2-aave`
liquidation plan — see [docs/STRATEGIES.md](../docs/STRATEGIES.md) for why liquidations have
negative expected value at current infrastructure.

## Backlog

| Track | Summary | Why waiting |
|---|---|---|
| [002-observability-alerting](tracks/backlog/002-observability-alerting/) | SSE dashboard, Telegram alerts, pino logging | Mostly shipped in `b1ec7e7`. Remaining: `src/metrics.ts`, `/metrics`, tests, log rotation, Telegram digest |

## Blocked

None. Criteria for what qualifies are documented in
[tracks/blocked/README.md](tracks/blocked/README.md).

## Closed

| Track | Completed | Commit |
|---|---|---|
| [001-core-architecture](tracks/closed/001-core-architecture/) | 2026-09-22 | `889924e` |

## Superseded

- **phase-2-aave** — real Aave integration. Never started. Superseded by `003-funding-harvesting`
  because Aave V3 is $566M of Base's $6.44B TVL while Morpho Blue holds $4.565B at
  $271.7k/day in fees against Aave's $32.7k, and contested liquidations are decided on
  latency rather than analysis. Retained in git history; reactivate only if funding fails its
  backtest gate.

## Naming convention

`NNN-kebab-case-slug`, where `NNN` is a zero-padded sequence number for ordering and the
slug describes the work:

- `001-core-architecture`
- `002-observability-alerting`
- `003-funding-harvesting`

The older `phase-1` / `phase-1.5` / `phase-2-aave` scheme is retired. It implied a fixed
delivery order that no longer holds — the active track is not "phase 2" in any meaningful
sense, it is a different strategy on a different chain against a different venue.

Track directories are **not** renamed when a track changes state. Moving `active/` →
`backlog/` keeps the sequence number and the history coherent; renaming would renumber the
project for no benefit.

---

See [workflow.md](workflow.md) for the spec-driven development process, the track lifecycle,
and the plan/task conventions.
