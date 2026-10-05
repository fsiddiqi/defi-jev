# Phase 1.5 Monitoring — Implementation Plan

## Status: 🟡 IN PROGRESS

### Setup
- [x] Create `src/server/dashboard.ts` (SSE + HTML)
- [x] Create `src/server/telegram.ts` (alert helpers)
- [ ] Install deps: `npm i telegraf prom-client`
- [ ] Add `.env` vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

### Dashboard (Red → Green → Refactor)
- [x] SSE endpoint `/events` with event listeners
- [x] Static HTML dashboard with live table
- [ ] Wire into `src/index.ts` — call `initDashboard(3000)`
- [ ] Test: `npm run dev` → open localhost:3000 → verify live updates

### Telegram (Red → Green → Refactor)
- [ ] Write `src/server/telegram.test.ts` (mock telegraf)
- [ ] Implement `initTelegram()` + alert functions
- [ ] Wire into `src/index.ts`:
  - `alertSessionStart()` at boot
  - `alertLiquidation()` on execute
  - `alertSkipped()` on gate failure
  - `alertSessionEnd()` on complete
  - `alertError()` in catch blocks
- [ ] Add periodic digest (cron or interval)
- [ ] Test: set env vars → `npm run dry-run` → verify Telegram messages

### Logging (Red → Green → Refactor)
- [ ] Update `src/logging.ts` — add file transport with rotation
- [ ] Ensure JSON output in prod, pretty in dev
- [ ] Test: `LOG_LEVEL=debug npm run dry-run` → check `logs/bot.log`

### Health / Metrics
- [ ] Add `/api/health` to dashboard server
- [ ] Add `src/metrics.ts` with prom-client counters/gauges/histograms
- [ ] Expose `/metrics` endpoint
- [ ] Instrument: liquidation counter, profit/gas gauges, gate latency histogram

### Tests
- [ ] Dashboard: test SSE connection, event emission
- [ ] Telegram: mock telegraf, verify message formatting
- [ ] Metrics: verify counter increments

### Documentation
- [ ] Update README with dashboard/Telemetry section
- [ ] Add conductor track to `conductor/tracks.md`