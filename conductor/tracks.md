# Conductor Tracks

Active development tracks for defi-jev.

## Active

- **[phase-1-core](tracks/phase-1-core/)** — Core architecture ✅ COMPLETE
  - Jev classifier (mock + real API)
  - Risk gate framework
  - Paper executor
  - Full test coverage

- **[phase-1.5-monitoring](tracks/phase-1.5-monitoring/)** — Observability 🟡 IN PROGRESS
  - SSE dashboard (port 3000)
  - Telegram alerts (immediate + digest)
  - Structured file logging
  - Health endpoint + Prometheus metrics
  - ⚠️ Code shipped in `b1ec7e7`; `plan.md` checkboxes stale and `/metrics` still unimplemented

## Planned

- **[phase-2-funding](tracks/phase-2-funding/)** — Funding rate harvesting (Hyperliquid) 📋 NEXT
  - Replaces `phase-2-aave` — see [docs/STRATEGIES.md](../docs/STRATEGIES.md) for rationale
  - Backtester first (blocking gate) → live data pipeline → Jev integration → execution → calibration
  - Jev gates entries; deterministic code governs exits and all circuit breakers
  - Must beat passive delta-neutral hold (~9.86%/yr gross) to justify itself

- **phase-3-production** — Production hardening
  - Error recovery
  - Rate limiting
  - Mempool monitoring

## Deprecated

- **phase-2-aave** — Real Aave integration ❌ SUPERSEDED by `phase-2-funding`
  - Aave V3 is $566M of Base's $6.44B TVL; Morpho Blue is 8× larger
  - Contested liquidations are won on latency, not analysis
  - Retained in git history — reactivate only if funding fails its backtest gate

## Archived

(None yet)

---

See [workflow.md](workflow.md) for the spec-driven development process.
