# 004 Jev Liquidation Racing — Spec

## Strategy

**Minimal CLI: scan → Jev gates → atomic flash liquidation.**

- **Venue:** Base (Morpho Blue + Ionic)
- **Execution:** Balancer flash loan → IonicFlashLiquidation.sol (deployed, atomic)
- **Jev role:** Gates entries on abandoned liquidation candidates (200+ block age)
- **No server, no dashboard, no database, no metrics.** CLI only.

---

## Hard Constraints

1. **Jev gates entries only.** Execution, risk, circuit breakers are code.
2. **Fully atomic single-tx.** Flash loan → liquidate → seize → unwrap/swap → repay. No position registry, no hold time.
3. **Code never filters on attractiveness.** Capital and data-integrity constraints only.
4. **Jev failures fail closed.** No scan → no Jev eval → no entry.
5. **CLI shows only what is happening.** No synthetic data, no mock rows.

---

## Acceptance Criteria

### Stage 1 — Jev Client + Scan (Week 1)

- [ ] OpenRouter Jev client with Zod-validated output
- [ ] Morpho Blue GraphQL scan (LTV > 0.80) + Ionic chronic borrowers per-block
- [ ] 100 mock candidates from real production logs → Jev → zero schema errors
- [ ] Jev calibration: flat calibration → Jev removed → age filter beats Jev is valid outcome

### Stage 2 — Execution Integration (Week 2)

- [ ] IonicFlashLiquidation.sol call from TypeScript (Balancer flash loan)
- [ ] Paper mode: log Jev decision + would-execute, no broadcast
- [ ] 50 paper trades, profit forecast MAPE < 35%
- [ ] Real mode: manual approve top 5/cycle, 20 real liquidations, net profit > $0

### Stage 3 — Autonomous (Week 3+)

- [ ] Remove human approval
- [ ] Scale to all candidates that pass gates
- [ ] Monthly recalibration if ECE > 0.10 or win rate < 60%

---

## Execution Model

**Flash loan:** Balancer Vault on Base (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`)

**Collateral swap:** Uniswap V3 SwapRouter02 (`0x2626664c2603336E57B271c5C0b26F421741e481`)

**Slippage assumption:** 50 bps (to be measured)

**Gas cost model:** $0.50 base + scaling by position size

**Risk premiums:** stable $0.50/50bps, bluechip $1.00/100bps, lrt $3.00/200bps, long-tail $5.00/300bps

**Protocol margin modifiers:** ionic 1.0x, morpho-blue 1.2x

---

## Data Pipeline

| Source | Method | Cadence |
|---|---|---|
| Morpho Blue positions | GraphQL subgraph + on-chain | 3s scan |
| Ionic chronic borrowers | `getAccountSnapshot` per block | 1s (chronic loop) |
| Oracle freshness | Chainlink `latestRoundData` | 1s monitor |
| Gas price | Base RPC `eth_gasPrice` | Per Jev eval |

**Oracle divergence guard:** Pyth vs Chainlink > 50 bps → block all.

---

## Jev Decision Contract

### Input (per candidate, ~150 tokens)

```json
{
  "protocol": "morpho-blue",
  "borrower": "0x...",
  "collateral_asset": "wstETH",
  "borrow_asset": "USDC",
  "current_ltv": 0.885,
  "liquidation_threshold": 0.90,
  "collateral_balance_usd": 42500,
  "borrow_balance_usd": 37500,
  "seize_pct": 0.05,
  "expected_seize_usd": 2125,
  "oracle_freshness_s": 3.2,
  "gas_price_gwei": 45,
  "estimated_execution_gas": 850000,
  "recent_price_move_pct_30m": -2.1,
  "cascade_score": 0.68,
  "competition_seen_last_10_blocks": 2
}
```

### Output (validated, fails closed)

```json
{
  "action": "EXECUTE" | "QUEUE" | "SKIP",
  "confidence": 0.0...1.0,
  "reasoning_code": "high_ltv_low_competition_cascade_tail" | "low_edge_gas_risk" | "stale_oracle_skip" | "cascade_saturation",
  "priority": 1...10
}
```

---

## Risk Gates (Code Only)

**Pre-Jev:** Oracle stale, gas > 40% profit, seize < $500, borrower age < 3d, LTV spread < 2%

**Post-Jev:** Jev confidence < 0.55, forecast < $200, safety < 0.60, margin < $1k, max concurrent 5 → queue

**Execution:** Pre-execution LTV sanity, flash loan atomic, liquidate+seize+unwrap+swap+repay atomic

**Circuit breakers:** Daily loss > 5%, max DD > 15%, margin < $500, oracle div > 50bps, Jev 3 failures → 30min block, exec fail rate > 20% (last 50)

---

## Calibration & Measurement

| Metric | Target |
|---|---|
| Profit prediction MAPE | < 30% |
| Confidence ECE | < 0.10 |
| Win rate | > 65% |
| Gas efficiency | < 60% |
| Execution success | > 98% |

**Minimum N:** 50 resolved liquidations, 20 cascade events per window.

---

## Success Gate

**Move 3 passes → autonomous.** If Stage 1 shows Jev adds no value over age filter, remove Jev — that is a valid result.
