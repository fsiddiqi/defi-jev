# Closed

Completed tracks. Kept for history and for the reasoning behind past decisions — not
maintained.

## Contents

| Track | Completed | Commit |
|---|---|---|
| [001-core-architecture](./001-core-architecture/) | 2026-09-22 | `889924e` |

## Relationship to 003-funding-harvesting

The pipeline built here (state → classifier → risk gates → executor, event-driven, paper-only)
is reused by [003-funding-harvesting](../active/003-funding-harvesting/). `logging.ts`,
`telegram.ts`, and `events.ts` carry over as-is; `dashboard.ts` and the `risk-gates.ts`
pattern are adapted. The liquidation *domain* logic is rewritten.

Four correctness bugs shipped here are documented in `docs/STRATEGIES.md` and recorded in
003's plan so they are not reintroduced by copy-paste:

1. `askJev` never called the TypeSafe API — it computed local arithmetic with a hardcoded
   `is_safe = 0.8` while the dashboard labelled the mode "REAL"
2. `risk-gates.ts` gate 6 passed unconditionally — `ltvImprovement` compared a dollar profit
   to a dollar debt
3. Health factor was `Math.random()` in 0.75–0.90, decoupled from the hardcoded balances
4. The profit model used an 8% bonus against the real 5%, and ignored the close factor, the
   protocol fee, and the collateral→debt swap

## Entry criteria

Every plan task complete, every spec acceptance criterion met, CI green. Record the
completion commit so later tracks can trace inherited code to its origin.
