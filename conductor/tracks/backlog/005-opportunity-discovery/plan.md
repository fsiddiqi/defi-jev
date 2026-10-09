# Plan: 005 Opportunity Discovery Radar

## Phase 0 — Inventory

- [ ] Catalog S1–S4 against current code: what each already logs vs what the radar schema needs
- [ ] Define shared JSONL paper-log schema + log directory convention (`data/radar/<strategy>.jsonl`)
- [ ] Order the N1–N6 prospect list by read cost (API-first before RPC-heavy)

## Phase 1 — Radar Harness

- [ ] `src/radar/schema.ts` — paper-log row type + writer (strategy, chain, block, candidate_id, size_usd, source, annotations)
- [ ] `src/radar/runner.ts` — `npm run radar -- <strategy>` entry reusing `src/scan.ts` / `src/lib/*`
- [ ] S1 + S2 piggyback logging in the live scan loop (cached reads only, zero extra RPC)

## Phase 2 — Prospecting (one task per strategy; kill notes count as done)

- [ ] S1 raw-seize distribution (pre-gate sizes by collateral family × chain)
- [ ] S2 wave clustering (wave size/timing per market, 7 days)
- [ ] S3 spread persistence (borrow-vs-staking net of fees, 7 days)
- [ ] S4 dust steady-state (sub-threshold positions left behind, 7 days)
- [ ] N4 oracle-lag lead time (spread-widening vs HF-cross timing)
- [ ] N1 first new protocol (largest-TVL unscanned venue: raw count/size vs Morpho)
- [ ] N2 discount frequency (>$10K depth, >2% vs redemption, 7 days)
- [ ] N5 claimable cadence (rewards/auctions vs gas, 7 days)
- [ ] N3 paper triangles (quotes-positive loop frequency net of gas, sampled)
- [ ] N6 auction/redemption fills (frequency × discount depth, 7 days)

## Phase 3 — Ranking + Graduation

- [ ] Ranked table (frequency × median size × data confidence) with log pointers
- [ ] Graduate / park (trigger + date) / kill (evidence) decision per strategy
- [ ] Graduate proposal(s) as new backlog track(s) with realizability gates restored
