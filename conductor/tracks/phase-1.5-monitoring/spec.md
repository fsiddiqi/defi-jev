# Phase 1.5: Monitoring & Alerting

Add observability to the core pipeline: real-time dashboard, structured logs, Telegram alerts.

## Acceptance Criteria

### Dashboard (SSE + Static HTML)
- ✅ SSE endpoint (`/events`) streams pipeline events
- ✅ Static HTML served at `/` (port 3000)
- ✅ Shows: opportunities table, Jev decisions, gate results, execution fills, session stats
- ✅ Auto-reconnect on SSE disconnect
- ✅ Zero external deps (vanilla JS, no build step)

### Telegram Alerts
- [ ] `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars
- [ ] Immediate alert on liquidation executed (profit, gas, account)
- [ ] Immediate alert on skipped opportunity (reason)
- [ ] Periodic digest (configurable interval, default 6h): count, PnL, best/worst
- [ ] Error alerts (fatal, RPC failure, Jev API failure)
- [ ] Cooldown/dedup to prevent spam

### Structured Logging
- [ ] Pino file transport (`logs/bot.log`) with rotation
- [ ] JSON lines for log aggregation (Loki, Datadog)
- [ ] Log level configurable via `LOG_LEVEL`

### Health / Metrics
- [ ] `/api/health` endpoint (liveness)
- [ ] Prometheus metrics: `jev_liquidations_total`, `jev_profit_usd`, `jev_gas_usd`, `jev_gate_latency_seconds`

## Non-Goals
- Authentication/authorization on dashboard
- Historical persistence (DB) — Phase 2
- Multi-user dashboard

## Success Metrics
1. `npm run dev` → dashboard at `http://localhost:3000` shows live updates
2. Telegram receives test alert on startup
3. `logs/bot.log` contains JSON lines
4. `/api/health` returns 200 OK