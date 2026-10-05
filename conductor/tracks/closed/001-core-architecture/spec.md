# Phase 1: Core Architecture

Build the foundation of the liquidation bot: state models, decision classifier, risk gates, and paper executor.

## Acceptance Criteria

### State Management
- ✅ LiquidationState interface defined (collateral, debt, LTV, gas, profit fields)
- ✅ Mock state generator (generateMockLiquidationState)
- ✅ Batch generator (generateMockLiquidationBatch)
- ✅ State formatter for logging (formatState)

### Jev Classifier
- ✅ JevDecision interface (urgency, profitability, safety, confidence)
- ✅ Real API integration (askJev) with error handling
- ✅ Mock classifier (askJevMock) for testing without API key
- ✅ Proper fallback when API unavailable

### Risk Gates
- ✅ RiskGateConfig with 6 criteria:
  - Urgency ≥ 60%
  - Profitability ≥ $25
  - Safety ≥ 70%
  - Gas cost ≤ $200
  - Min profit ≥ $10
  - LTV improvement acceptable
- ✅ GateCheckResult with passed/failed gates
- ✅ checkRiskGates() function
- ✅ Gate check result logging

### Paper Executor
- ✅ PaperFill interface (timestamp, account, assets, profit, status)
- ✅ PaperExecutor class with:
  - execute(state) → simulated trade
  - getFills() → transaction history
  - getStats() → cumulative metrics
  - reset() → clear session
- ✅ Profit tracking (gas, profit, cumulative)

### Event System
- ✅ EventEmitter class with on() / emit()
- ✅ Event types: state:generated, jev:decision, gates:checked, liquidation:executed, session:stats
- ✅ Safe error handling in event callbacks

### Main Bot Loop
- ✅ Generate 5 mock opportunities
- ✅ Pipeline: state → Jev → gates → executor
- ✅ Event emission at each stage
- ✅ Session summary logging
- ✅ Dry-run mode (no API calls, mock Jev)

### Testing
- ✅ 5 state generation tests
- ✅ 9 risk gate + executor tests
- ✅ 100% coverage of core modules
- ✅ All tests passing

### Configuration & Build
- ✅ TypeScript strict mode
- ✅ ESLint + Prettier
- ✅ Vitest with coverage
- ✅ GitHub Actions CI/CD
- ✅ npm scripts: build, test, lint, format, dry-run

### Documentation
- ✅ README.md (purpose, architecture, setup, API)
- ✅ Code comments (Google-style docstrings)
- ✅ Inline logging for bot flow

## Non-Goals (Phase 2+)
- Real Aave contract integration
- Account monitoring
- Live liquidation execution
- Mempool monitoring

## Success Metrics
1. All 14 tests pass
2. `npm run dry-run` processes 5 opportunities without error
3. Simulated profit is positive (~$79k expected)
4. Build succeeds with no TypeScript errors
5. CI/CD passes (linting, tests, build)
