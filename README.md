# defi-jev 🤖💰

AI-powered liquidation bot for Base lending protocols using TypeSafe's Jev System One model.

## Purpose

Autonomously identify and execute profitable liquidations on Aave (Base) by:
1. **Monitoring** account health factors on Base Aave pools
2. **Classifying** liquidation opportunities using Jev AI (urgency, profitability, safety)
3. **Filtering** through multi-gate risk framework (6 criteria)
4. **Executing** liquidations when profitable & safe
5. **Tracking** cumulative profit and gas costs

## Architecture

Three-layer pipeline:

```
State Monitor → Jev Classifier → Risk Gates → Paper/Live Executor
                                     ↓
                              Event Emitter (pub/sub)
```

- **State** (`src/state/`): LTV data models, mock generators
- **Classifier** (`src/jev/`): Jev API integration + mock fallback
- **Gates** (`src/execution/risk-gates.ts`): 6-point filter (urgency, profitability, safety, gas, profit, LTV)
- **Executor** (`src/execution/paper.ts`): Simulated trades; swap `paperExecutor` for real contract calls
- **Events** (`src/server/events.ts`): Event emitter for bot state flow
- **Logging** (`src/logging.ts`): Pino logger with dev/prod modes

## Getting Started

### Prerequisites
- Node.js 18+
- `npm` or `pnpm`

### Installation

```bash
git clone git@github.com:fsiddiqi/defi-jev.git
cd defi-jev
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:
- `TYPESAFE_API_KEY` — TypeSafe Jev API key (required for real scoring)
- `BASE_RPC_URL` — Base RPC endpoint (for account monitoring)
- `LOG_LEVEL` — debug | info | warn | error
- `NODE_ENV` — development | production
- `DRY_RUN` — true | false (dry-run uses mock Jev, no API calls)

## Running

### Dry-run (mock data, no API key needed)

```bash
npm run dry-run
```

Generates 5 mock liquidation opportunities, evaluates them through the pipeline, and simulates trades.

### Tests

```bash
npm test                    # Run all tests
npm test -- --ui           # Interactive UI mode
npm test -- --coverage     # Coverage report
```

**Test coverage:**
- `src/tests/state.test.ts` — 5 tests: state generation, overrides, batching
- `src/tests/execution.test.ts` — 9 tests: risk gates, paper executor

All 14 tests should pass. Run before committing:

```bash
npm test -- --run
npm run build
npm run lint
```

### Build

```bash
npm run build              # TypeScript → dist/
npm run lint               # ESLint check
npm run format             # Prettier auto-format
```

## Deployment

### Local Development

```bash
npm run dev                # Watch mode (tsx)
```

### Production

1. Build: `npm run build`
2. Start: `npm start` (or use Node directly: `node dist/index.ts`)
3. Set `NODE_ENV=production` and real API keys in `.env`

### Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.ts"]
```

## Project Status

**Phase 1 (Current):** ✅ Core architecture complete
- ✅ State models and mock data
- ✅ Jev classifier (mock + real API fallback)
- ✅ Risk gate framework (6-point filter)
- ✅ Paper executor with profit tracking
- ✅ Event emitter + logging
- ✅ Full test coverage (14/14 passing)
- ✅ Dry-run verified (~$79k simulated profit on 5 opportunities)

**Phase 2 (Planned):** Real integrations
- [ ] Aave v3 contract integration (liquidationCall)
- [ ] Account monitoring (Aave subgraph or RPC polling)
- [ ] Swap integration (1inch/Uniswap for bonus → stablecoin)
- [ ] Real liquidation execution
- [ ] Transaction mempool monitoring (frontrun/sandwich detection)

**Phase 3 (Future):** Production hardening
- [ ] Rate limiting & health checks
- [ ] Error recovery & retry logic
- [ ] Multi-pool support (Compound, others)
- [ ] Dashboard & metrics
- [ ] Audit & security review

## API Reference

### State

```typescript
interface LiquidationState {
  collateral_asset: string;          // e.g., "WETH"
  collateral_amount: string;         // wei
  collateral_price_usd: string;      // e.g., "2500"
  debt_asset: string;                // e.g., "USDC"
  debt_amount: string;               // smallest unit
  ltv_current: number;               // 0.75 = 75%
  ltv_liquidation_threshold: number; // 0.85 = 85%
  profit_after_gas: number;          // USD
  // ... more fields
}
```

### Jev Classifier

```typescript
const decision = await askJev(state);
// or
const decision = await askJevMock(state);

// Returns:
interface JevDecision {
  urgency: number;       // 0-1: how close to liquidation
  profitability: number; // 0-100: profit potential
  is_safe: number;       // 0-1: sandwich/frontrun risk
  confidence: number;    // 0-1: average confidence
}
```

### Risk Gates

```typescript
const result = checkRiskGates(decision, state);

// Filters on:
// ✓ Urgency ≥ 60%
// ✓ Profitability ≥ $25
// ✓ Safety ≥ 70%
// ✓ Gas cost ≤ $200
// ✓ Min profit ≥ $10
// ✓ LTV improvement acceptable

if (result.should_execute) {
  await paperExecutor.execute(state);
}
```

### Paper Executor

```typescript
const fill = await paperExecutor.execute(state);
// Returns: { timestamp, user_address, debt_closed_usd, gas_spent_usd, profit_usd, status }

const stats = paperExecutor.getStats();
// { count, total_gas_usd, total_profit_usd, average_profit_per_liquidation }
```

## Contributing

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Write tests first (TDD)
3. Run full test suite: `npm test -- --run && npm run lint && npm run build`
4. Commit: `git commit -m "feat: description"`
5. Push: `git push origin feat/your-feature`
6. Open PR to `main`

## License

MIT

## Resources

- [TypeSafe Jev Docs](https://typesafe.ai/docs/jev)
- [Aave V3 Docs](https://docs.aave.com/developers/v/2.0/)
- [Base RPC Docs](https://docs.base.org/)
- [Conductor Workflow](conductor/workflow.md)

---

**Maintained by:** [@fsiddiqi](https://github.com/fsiddiqi)
