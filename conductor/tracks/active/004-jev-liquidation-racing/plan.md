# Plan: 004 Jev Liquidation Racing

## Phase 0 — Project Setup

- [ ] `package.json` with deps: viem, zod, dotenv, @graphql-request, openrouter client
- [ ] `tsconfig.json` (strict, ES2022, NodeNext)
- [ ] `.env.example` with: RPC_URL, PRIVATE_KEY, OPENROUTER_API_KEY, MORPHO_SUBGRAPH
- [ ] `.gitignore` (node_modules, dist, .env, *.log)

## Phase 1 — Jev Client + Scan

- [ ] `src/jev/client.ts` — OpenRouter call, Zod schema validation, cost tracking
- [ ] `src/scan/morpho.ts` — GraphQL query, LTV > 0.80 filter
- [ ] `src/scan/ionic.ts` — chronic borrowers (6 addresses) per-block
- [ ] `src/scan/index.ts` — unified scan loop, 3s cadence
- [ ] `src/oracle/monitor.ts` — Chainlink freshness, 1s, 50bps divergence guard
- [ ] `src/main.ts` — CLI entry, scan → Jev → execute flow

## Phase 2 — Execution

- [ ] `src/execute/ionic.ts` — IonicFlashLiquidation.sol call via viem
- [ ] `src/execute/balancer.ts` — flash loan calldata encoding
- [ ] `src/execute/index.ts` — atomic execution wrapper, paper/real modes

## Phase 3 — Paper → Real

- [ ] `--paper` flag: logs decision, no broadcast
- [ ] 50 paper trades, profit forecast MAPE < 35%
- [ ] `--approve` flag: human confirms top 5/cycle
- [ ] 20 real liquidations, net profit > $0

## Phase 4 — Autonomous

- [ ] Remove `--approve`, auto-execute on Jev PASS
- [ ] Monthly recalibration script
