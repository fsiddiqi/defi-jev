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

**None.** No track is currently in progress.

## Backlog

| Track | Summary | Why waiting |
|---|---|---|
| [003-funding-harvesting](tracks/backlog/003-funding-harvesting/) | Delta-neutral funding carry on Hyperliquid | Spec complete, Stage 1 unblocked. Measured ceiling is 6.57-7.39%/yr on committed capital — thin for the complexity. Reactivation gate: standalone backtest first |
| [002-observability-alerting](tracks/backlog/002-observability-alerting/) | SSE dashboard, Telegram alerts, pino logging | Mostly shipped in `b1ec7e7`. Remaining: `src/metrics.ts`, `/metrics`, tests, log rotation, Telegram digest |

## Blocked

None. Criteria for what qualifies are documented in
[tracks/blocked/README.md](tracks/blocked/README.md).

## Closed

| Track | Completed | Commit |
|---|---|---|
| [001-core-architecture](tracks/closed/001-core-architecture/) | 2026-09-22 | `889924e` |

## Superseded

- **phase-2-aave** — Aave liquidation bot. Never started. Superseded by
  `003-funding-harvesting`, which is itself now in backlog. Retained in git history;
  reactivate only if funding is abandoned outright.

## Naming convention

`NNN-kebab-case-slug`, where `NNN` is a zero-padded sequence number for ordering and the
slug describes the work:

- `001-core-architecture`
- `002-observability-alerting`
- `003-funding-harvesting`

The older `phase-1` / `phase-1.5` / `phase-2-aave` scheme is retired. It implied a fixed
delivery order that no longer holds — tracks are a different strategy on a different chain
against a different venue, ordered by priority rather than by number.

Track directories are **not** renamed when a track changes state. Moving `active/` →
`backlog/` keeps the sequence number and the history coherent; renaming would renumber the
project for no benefit.

---

See [workflow.md](workflow.md) for the spec-driven development process, the track lifecycle,
and the plan/task conventions.
