import "dotenv/config";
import { createPublicClient, createWalletClient, fallback, http, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { JevClient, createJevClientFromEnv } from "./jev/client.js";
import { scanAll } from "./scan.js";
import { checkOracleFreshness, checkOracleDivergence, fetchEthPrice } from "./oracle.js";
import { executeLiquidation } from "./execute.js";
import type { LiquidationCandidate, ExecutionConfig, JevDecision, ScanStats } from "./types.js";
import { startServer, getState, addFeedEntry, updateFeedEntry, feedKey } from "./server.js";
import { ETH_USD_ASSUMED, gasCostUsd, projectedProfitUsd } from "./profit.js";
import { dataIntegrityGate, preJevGates } from "./lib/gates.js";
import { candidateContextHash } from "./lib/scanMath.js";
import { isWatchPlayable, type WatchPlayableConfig } from "./lib/watch.js";

// Feed rows are keyed by (borrower, market): a borrower holding collateral in
// two markets must not have one row overwrite the other.
const feedRow = (c: LiquidationCandidate) => ({
  borrower: c.borrower,
  collateralAsset: c.collateralAsset,
  borrowAsset: c.borrowAsset,
});

// Same (borrower, market) key for the Jev cache and decision map. A borrower
// who is liquidatable in one market and at-risk in another is TWO candidates —
// keying the cache by borrower alone would let one market's decision leak into
// the other's row.
const candidateKey = (c: LiquidationCandidate) => feedKey(feedRow(c));

// Jev gate mode: "confidence" (TypeSafe confidence) or "probability" (p(EXECUTE))
const JEV_GATE_MODE = process.env.JEV_GATE_MODE ?? "probability";
const MIN_JEV_CONFIDENCE = Number(process.env.MIN_JEV_CONFIDENCE ?? "0.55");
const MIN_JEV_EXECUTE_PROB = Number(process.env.MIN_JEV_EXECUTE_PROB ?? "0.40");

// ── Config from env ──────────────────────────────────────────────────────────





const CONFIG: ExecutionConfig = {
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? "5"),
  minSeizeUsd: Number(process.env.MIN_SEIZE_USD ?? "500"),
  minProfitForecastUsd: Number(process.env.MIN_PROFIT_FORECAST_USD ?? "200"),
  minJevConfidence: Number(process.env.MIN_JEV_CONFIDENCE ?? "0.55"),
  minJevSafety: Number(process.env.MIN_JEV_SAFETY ?? "0.60"),
  marginBufferUsd: Number(process.env.MARGIN_BUFFER_USD ?? "2000"),
  gasCostPctOfProfitMax: Number(process.env.GAS_COST_PCT_OF_PROFIT_MAX ?? "0.40"),
  oracleDivergenceBps: Number(process.env.ORACLE_DIVERGENCE_BPS ?? "50"),
};

const PAPER_MODE = process.argv.includes("--paper");
const SCAN_ONLY = process.argv.includes("--scan-only");
const APPROVE_MODE = process.argv.includes("--approve");
const AUTO_MODE = !PAPER_MODE && !SCAN_ONLY && !APPROVE_MODE;

if (!process.env.RPC_URL) throw new Error("RPC_URL required");
if (!SCAN_ONLY && !PAPER_MODE && !process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY required for execution modes");
if (!SCAN_ONLY && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY required");

const rpcUrl = process.env.RPC_URL;
const privateKey = process.env.PRIVATE_KEY ? (process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`) : undefined;

// Primary RPC (often free/mainnet.base.org) with public fallbacks — the free
// endpoint rate-limits hard once scanning + oracle reads ramp up.
const publicTransport = rpcUrl
  ? fallback([http(rpcUrl), http("https://base-rpc.publicnode.com"), http("https://1rpc.io/base")])
  : undefined;
const publicClient = createPublicClient({ chain: base, transport: publicTransport ?? http(rpcUrl) }) as any;
const wallet = privateKey ? createWalletClient({
  chain: base,
  transport: http(rpcUrl),
  account: privateKeyToAccount(privateKey as `0x${string}`),
}) : undefined;

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const mode = PAPER_MODE ? "PAPER" : SCAN_ONLY ? "SCAN-ONLY" : APPROVE_MODE ? "APPROVE" : "AUTO";
  console.log(`[${new Date().toISOString()}] Starting liquidation racing CLI`);
  console.log(`  Mode: ${mode}`);
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Wallet: ${wallet?.account.address ?? "(none)"}`);

  // Start web UI
  const state = getState();
  state.mode = mode;
  state.running = true;
  state.startTime = Date.now();
  startServer(Number(process.env.UI_PORT ?? 3000), process.env.UI_HOST ?? "0.0.0.0");

  const jev = createJevClientFromEnv();
  const stats: ScanStats = {
    candidatesFound: 0,
    candidatesEvaluated: 0,
    jevExecute: 0,
    jevQueue: 0,
    jevSkip: 0,
    executed: 0,
    reverted: 0,
    failed: 0,
    startTime: Date.now(),
  };

  let consecutiveJevFailures = 0;
  const MAX_JEV_FAILURES = 3;
  let cycleCount = 0;

  // Re-evaluate each borrower with Jev at most once per JEV_REEVAL_SEC, AND
  // whenever its input context actually changed (hash compared below). If a
  // position hasn't moved since the last judgment, re-judging would produce
  // the same decision at API cost — so identical-context candidates are reused
  // regardless of age. Steady state costs ~0 tokens while the market is quiet.
  const JEV_REEVAL_MS = Number(process.env.JEV_REEVAL_SEC ?? "1800") * 1000;
  const jevCache = new Map<string, { decision: JevDecision; at: number; contextHash: string }>();

  // Scan cadence — configurable to reduce Morpho API usage (free part; drives
  // how fast NEW liquidations are detected, indexer-bound anyway).
  const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? "30000");
  state.scanIntervalMs = SCAN_INTERVAL_MS;

  // Playable slice of the at-risk watchlist: sized for a solo bot, profit above
  // a floor, oracle age verifiable. Classification only — never a gate.
  const WATCH_PLAYABLE: WatchPlayableConfig = {
    capUsd: Number(process.env.WATCH_PLAYABLE_CAP_USD ?? "250000"),
    minProfitUsd: Number(process.env.WATCH_MIN_PROFIT_USD ?? "500"),
    maxOracleAgeSec: Number(process.env.WATCH_ORACLE_MAX_AGE_SEC ?? "300"),
  };
  state.playable = { ...WATCH_PLAYABLE };

  // Candidates per Jev batch API call. Keep large: JEV_BATCH_SIZE amortizes
  // the fixed instruction cost across many candidates (auto-halves on
  // max_tokens_exceeded). Jev ingests large contexts cheaply per candidate.
  const JEV_BATCH_SIZE = Number(process.env.JEV_BATCH_SIZE ?? "64");

  // Minimum gap between Jev API calls — never fire more than one call per
  // interval. Fresh candidates accumulate across scan cycles and are judged
  // together in one big batch instead of one call per 30s scan.
  const JEV_MIN_INTERVAL_MS = Number(process.env.JEV_MIN_INTERVAL_MS ?? "120000");
  let lastJevCallAt = 0;

  // Largest Jev chunk size that ever succeeded. The API rejects any batch
  // whose context would exceed its cap (max_tokens_exceeded), so the first
  // oversized batch is halved until it fits — and that learned size is KEPT
  // for the rest of the run. The old code reset to JEV_BATCH_SIZE after every
  // success, so every chunk re-paid the same failed calls: 1,267 rejected
  // requests across one run.
  let knownGoodBatch = JEV_BATCH_SIZE;

  // Waits out the gap before the next scan and publishes the deadline so the
  // UI can count down ("next scan in 18s") instead of only showing how long
  // ago the last one was. Set immediately before sleeping, i.e. after all of
  // this cycle's work, so the countdown hits 0 exactly when scanning resumes.
  const pauseUntilNextScan = async (ms: number): Promise<void> => {
    state.nextScanAt = Date.now() + ms;
    await sleep(ms);
  };

  while (true) {
    try {
      // 1. Fetch ETH price
      const ethPriceUsd = SCAN_ONLY ? 2700 : await fetchEthPrice(publicClient);
      state.ethPriceUsd = ethPriceUsd;

      // 2. Scan for candidates
      console.log(`\n[${new Date().toISOString()}] Scanning...`);
      state.lastScanAt = new Date().toISOString();
      const candidates = await scanAll(publicClient, ethPriceUsd);
      stats.candidatesFound += candidates.length;
      state.stats = { ...stats };
      state.jevStats = jev.getStats();
      console.log(`  Found ${candidates.length} candidates (seize >= $${CONFIG.minSeizeUsd})`);

      if (SCAN_ONLY) {
        for (const c of candidates) {
          console.log(`    ${c.protocol} ${c.borrower.slice(0,8)} LTV=${(c.currentLtv*100).toFixed(1)}% seize=$${c.expectedSeizeUsd.toFixed(2)}`);
        }
        await pauseUntilNextScan(3000);
        continue;
      }

      // 3. Oracle divergence guard
      const divergence = await checkOracleDivergence(publicClient, "WETH");
      if (divergence.diverged && divergence.pctDiff > CONFIG.oracleDivergenceBps / 10000) {
        console.warn(`  Oracle divergence ${(divergence.pctDiff*100).toFixed(2)}% > ${CONFIG.oracleDivergenceBps}bps - BLOCKING ALL`);
        await pauseUntilNextScan(30000);
        continue;
      }

      // 4. Evaluate candidates with Jev — pre-filter first, then ONE batched
      // API call for every candidate whose cache expired (instead of N calls).
      let cachedJevDecisions = 0;
      const eligible: LiquidationCandidate[] = []; // passed pre-Jev gates
      const decisionOf = new Map<string, JevDecision>();

      for (const candidate of candidates) {
        stats.candidatesEvaluated++;

        // Add to UI feed
        addFeedEntry({
          timestamp: new Date().toISOString(),
          protocol: candidate.protocol,
          borrower: candidate.borrower,
          collateralAsset: candidate.collateralAsset,
          borrowAsset: candidate.borrowAsset,
          currentLtv: candidate.currentLtv,
          healthFactor: candidate.healthFactor,
          expectedSeizeUsd: candidate.expectedSeizeUsd,
          projectedProfitUsd: projectedProfitUsd(candidate, ethPriceUsd),
          gasPriceGwei: candidate.gasPriceGwei,
          priceSource: candidate.priceSource,
          exitLiquidityUsd: candidate.exitLiquidityUsd,
          dexPriceUsd: candidate.dexPriceUsd,
          oraclePriceUsd: candidate.oraclePriceUsd,
          saleVenue: candidate.saleVenue,
          oracleAgeSec: candidate.oracleAgeSec,
          decision: null,
          gateResult: null,
        });

        // At-risk watch rows are pre-judged ONLY while a warm verdict could
        // ever be spent: playable = fundable seize (cap), warm profit above the
        // floor, verifiable oracle age (see lib/watch.ts). Everything else in
        // the HF 0.98-1.30 band — dust, unprofitable, stale-oracle — cannot
        // execute even if it crossed the line, so its warm verdict is dead
        // weight: those rows were ~90% of judged candidates (410 of 459) and
        // the bulk of the Jev token bill. Show them, never bill for them.
        if (candidate.watch && !isWatchPlayable(candidate, WATCH_PLAYABLE, ethPriceUsd)) {
          updateFeedEntry(feedRow(candidate), {
            gateResult: "watch",
            gateReason: "at-risk, not playable (size / profit floor / oracle age) - not judged",
            playable: false,
          });
          continue;
        }

        // Pre-Jev gates — skipped for at-risk watch rows on purpose: they are
        // not executable today (HF > 1.0) and the point of the watchlist is
        // Jev's WARM verdict on every visible position, so the verdict is
        // already computed when one crosses into liquidation.
        const preJev = candidate.watch ? { pass: true as const, reason: "" } : preJevGates(candidate, CONFIG);
        if (!preJev.pass) {
          stats.jevSkip++;
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: `pre-Jev: ${preJev.reason}` });
          state.stats = { ...stats };
          console.log(`    Pre-Jev: ${preJev.reason}`);
          continue;
        }

        // Deterministic HF data-integrity gate (moved OUT of Jev: the
        // classifier read the raw HF pair and flagged every row
        // ltv_hf_inconsistent regardless of values, including 0.0% mismatches).
        const integrity = dataIntegrityGate(candidate, Number(process.env.MAX_HF_MISMATCH_PCT ?? "0.30"));
        if (!integrity.pass) {
          stats.jevSkip++;
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: integrity.reason });
          state.stats = { ...stats };
          console.log(`    Data-integrity gate: ${integrity.reason} - skipping ${candidate.borrower.slice(0,8)}`);
          continue;
        }

        // Reuse the cached decision if it is still fresh, OR if the input
        // context is bit-identical to what was last judged (decision is a
        // deterministic function of this context — re-judging is a no-op).
        const cached = jevCache.get(candidateKey(candidate));
        const ctxHash = candidateContextHash(candidate);
        if (cached && (Date.now() - cached.at < JEV_REEVAL_MS || cached.contextHash === ctxHash)) {
          decisionOf.set(candidateKey(candidate), cached.decision);
          cachedJevDecisions++;
        }
        eligible.push(candidate);
      }

      // Batch-evaluate all candidates with expired/missing cache.
      // One API call per chunk (JEV_BATCH_SIZE); max_tokens_exceeded retries
      // with progressively smaller chunks so a single oversized batch can't
      // burn the whole cycle.
      const fresh = eligible.filter((c) => !decisionOf.has(candidateKey(c)));
      let apiCalls = 0;
      // Coalesce fresh evaluations: never fire a Jev call more often than
      // JEV_MIN_INTERVAL_MS. Fresh candidates accumulate across scan cycles
      // and get judged together in one big batch — leverages Jev's
      // large-context ingestion, stops hammering the API with per-cycle calls.
      const deferFresh = fresh.length > 0 && Date.now() - lastJevCallAt < JEV_MIN_INTERVAL_MS;
      if (fresh.length > 0 && !deferFresh) {
        let evaluated = 0;
        let batchSize = knownGoodBatch;
        consecutiveJevFailures = 0;
        while (evaluated < fresh.length) {
          const chunk = fresh.slice(evaluated, evaluated + batchSize);
          try {
            const decisions = await jev.evaluateBatch(chunk, ethPriceUsd);
            consecutiveJevFailures = 0;
            const now = Date.now();
            chunk.forEach((candidate, i) => {
              const d = decisions[i];
              decisionOf.set(candidateKey(candidate), d);
              jevCache.set(candidateKey(candidate), { decision: d, at: now, contextHash: candidateContextHash(candidate) });
              updateFeedEntry(feedRow(candidate), {
                decision: { action: d.action, confidence: d.confidence, executeProb: d.actionProbabilities.EXECUTE ?? 0, reasoningCode: d.reasoningCode, priority: d.priority, sanity: d.sanity },
              });
              console.log(`  Jev: ${d.action} (conf=${d.confidence.toFixed(2)}, code=${d.reasoningCode}, pri=${d.priority}, sanity=${d.sanity}) ${candidate.borrower.slice(0,8)} seize=$${candidate.expectedSeizeUsd.toFixed(0)}`);
            });
            apiCalls++;
            evaluated += chunk.length;
            knownGoodBatch = batchSize; // largest size that ever worked
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (batchSize > 1) {
              batchSize = Math.max(1, Math.floor(batchSize / 2));
              knownGoodBatch = Math.min(knownGoodBatch, batchSize);
              console.warn(`  Jev batch error (${msg}) - halving batch size to ${batchSize}`);
              continue; // retry this slice with a smaller chunk
            }
            consecutiveJevFailures++;
            console.error(`  Jev error (${consecutiveJevFailures}/${MAX_JEV_FAILURES}): ${msg}`);
            if (consecutiveJevFailures >= MAX_JEV_FAILURES) {
              console.error(`  MAX JEV FAILURES REACHED - BLOCKING 30 MINUTES`);
              await pauseUntilNextScan(30 * 60 * 1000);
              consecutiveJevFailures = 0;
            }
            stats.jevSkip++;
            updateFeedEntry(feedRow(chunk[0]), { gateResult: "blocked", gateReason: "jev call failed" });
            evaluated++;
          }
        }
        if (apiCalls > 0) lastJevCallAt = Date.now();
      } else if (deferFresh) {
        console.log(`  Jev: deferring ${fresh.length} fresh candidate(s) (${Math.round((Date.now() - lastJevCallAt) / 1000)}s since last call) - coalescing`);
      }
      console.log(`  Jev: ${fresh.length} candidates in ${apiCalls} call(s), ${cachedJevDecisions} cached decisions`);
      for (const candidate of eligible) {
        const jevDecision = decisionOf.get(candidateKey(candidate));
        if (!jevDecision) continue;

        // Surface the verdict on the row regardless of how it got here (fresh
        // batch or warm cache) — a re-added row must show its decision, not "…".
        updateFeedEntry(feedRow(candidate), {
          decision: {
            action: jevDecision.action,
            confidence: jevDecision.confidence,
            executeProb: jevDecision.actionProbabilities.EXECUTE ?? 0,
            reasoningCode: jevDecision.reasoningCode,
            priority: jevDecision.priority,
            sanity: jevDecision.sanity,
          },
        });

        // At-risk watch row: never executes today. Record the warm verdict —
        // the instant HF dips below 1.0 the position re-scans as a live
        // candidate, its context hash changes, and Jev re-judges it under the
        // real gates. Until then this row is a monitored queue, not a trade.
        if (candidate.watch) {
          updateFeedEntry(feedRow(candidate), {
            gateResult: "watch",
            gateReason: `HF ${candidate.healthFactor.toFixed(4)} (not liquidatable) · Jev warm: ${jevDecision.action}`,
            playable: isWatchPlayable(candidate, WATCH_PLAYABLE, ethPriceUsd),
          });
          if (jevDecision.action === "EXECUTE") {
            console.log(`    [watch] ${candidate.borrower.slice(0,8)} ${candidate.collateralAsset} HF=${candidate.healthFactor.toFixed(4)} — Jev: EXECUTE-worthy if liquidatable (profit=$${projectedProfitUsd(candidate, ethPriceUsd).toFixed(2)})`);
          }
          continue;
        }

        // Count Jev actions
        if (jevDecision.action === "EXECUTE") stats.jevExecute++;
        else if (jevDecision.action === "QUEUE") stats.jevQueue++;
        else stats.jevSkip++;
        state.stats = { ...stats };

        // Post-Jev gates
        const gateFail = postJevGates(jevDecision, candidate, CONFIG, ethPriceUsd);
        if (gateFail) {
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: gateFail });
          if (jevDecision.action === "EXECUTE") {
            console.log(`    Post-Jev gate failed (${gateFail}) - skipping ${candidate.borrower.slice(0,8)}`);
          }
          continue;
        }
        updateFeedEntry(feedRow(candidate), { gateResult: "passed" });

        // Execute or log
        if (jevDecision.action === "EXECUTE") {
          if (PAPER_MODE) {
            console.log(`    [PAPER] Would execute: ${candidate.protocol} ${candidate.borrower.slice(0,8)} seize=$${candidate.expectedSeizeUsd.toFixed(2)} profit=$${projectedProfitUsd(candidate, ethPriceUsd).toFixed(2)}`);
            stats.executed++;
            updateFeedEntry(feedRow(candidate), { executed: true });
          } else if (!wallet) {
            console.log(`    ❌ No wallet configured - cannot execute`);
            stats.failed++;
          } else if (APPROVE_MODE) {
            console.log(`    [APPROVE] Execute? ${candidate.protocol} ${candidate.borrower.slice(0,8)} seize=$${candidate.expectedSeizeUsd.toFixed(2)} (y/N)`);
            // In real impl, read from stdin with timeout
            // For now, auto-approve for demo
            const result = await executeLiquidation(candidate, CONFIG, wallet, publicClient);
            logExecution(result, stats);
          } else {
            // AUTO mode
            const result = await executeLiquidation(candidate, CONFIG, wallet, publicClient);
            logExecution(result, stats);
          }
        }
      }

      // End-of-cycle status heartbeat — one readable line with cadence,
      // Jev usage and cost, and when the model is consulted again.
      cycleCount++;
      const nowMs = Date.now();
      state.cycle = cycleCount;
      state.jevApiCallsLastCycle = apiCalls;
      if (fresh.length > 0) {
        state.lastJevBatchAt = new Date(nowMs).toISOString();
        state.nextJevRefreshAt = nowMs + JEV_REEVAL_MS;
      }
      const jevTotal = jev.getStats();
      const uptimeMin = ((nowMs - state.startTime) / 60000).toFixed(1);
      const refreshIn = state.nextJevRefreshAt ? Math.max(0, Math.ceil((state.nextJevRefreshAt - nowMs) / 1000)) : 0;
      const callsPerHr = jevTotal.totalCalls > 0
        ? Math.round(jevTotal.totalCalls / (Math.max(1, nowMs - state.startTime) / 3600000))
        : 0;
      const tokensPerHr = jevTotal.totalTokensIn > 0
        ? Math.round(jevTotal.totalTokensIn / (Math.max(1, nowMs - state.startTime) / 3600000))
        : 0;
      console.log(`  [status] cycle=${cycleCount} uptime=${uptimeMin}min | candidates=${candidates.length} jev=${apiCalls} call(s) (${fresh.length} fresh, ${cachedJevDecisions} cached) | total=${jevTotal.totalCalls} calls, ${(jevTotal.totalTokensIn / 1000).toFixed(0)}K tokens in (${(tokensPerHr / 1000).toFixed(0)}K/hr, ~${callsPerHr}/hr) | next jev refresh in ${refreshIn}s`);

      // Stats heartbeat every cycle
      if (stats.candidatesEvaluated % 10 === 0) {
        printStats(stats, jev.getStats());
      }
      state.stats = { ...stats };
      state.jevStats = jevTotal;

      await pauseUntilNextScan(SCAN_INTERVAL_MS); // configurable scan cadence (default 30s)

    } catch (e) {
      console.error(`[${new Date().toISOString()}] Loop error: ${e instanceof Error ? e.message : String(e)}`);
      await pauseUntilNextScan(5000);
    }
  }
}

// Seize minus estimated gas minus 50bps slippage — see src/profit.ts
// (single source of truth, also fed to Jev as state).

// Returns null when the candidate passes, otherwise the reason it was blocked.
// JEV_SANITY_GATE=false disables the sanity verdict check (default: enabled).
// JEV_GATE_MODE=confidence|probability selects how EXECUTE is gated.
//   confidence: TypeSafe confidence >= MIN_JEV_CONFIDENCE (default 0.55)
//   probability: p(EXECUTE) >= MIN_JEV_EXECUTE_PROB (default 0.40)
function postJevGates(decision: JevDecision, candidate: LiquidationCandidate, config: ExecutionConfig, ethPriceUsd: number = ETH_USD_ASSUMED): string | null {
  // Action first: a SKIP/QUEUE is blocked regardless of confidence/probability.
  if (decision.action !== "EXECUTE") return `jev action ${decision.action}`;

  // Configurable EXECUTE gate
  const executeProb = decision.actionProbabilities.EXECUTE ?? 0;
  if (JEV_GATE_MODE === "probability") {
    if (executeProb < MIN_JEV_EXECUTE_PROB) {
      return `jev p(EXECUTE) ${executeProb.toFixed(2)} < ${MIN_JEV_EXECUTE_PROB}`;
    }
  } else {
    // TypeSafe Choice confidence = (p_max - 1/n) / (1 - 1/n), n=3 here, so this
    // maps to p(EXECUTE) = 1/3 + confidence * 2/3. 0.55 => p >= 0.70.
    if (decision.confidence < config.minJevConfidence) {
      return `jev confidence ${decision.confidence.toFixed(2)} < ${config.minJevConfidence}`;
    }
  }

  // Sanity gate: Jev says the projected economics don't reconcile on-chain
  if (process.env.JEV_SANITY_GATE !== "false" && decision.sanity !== "plausible") {
    const pct = (decision.sanityConfidence * 100).toFixed(0);
    return `jev sanity: ${decision.sanity} (${pct}%)`;
  }

  // Profit forecast check
  const gasCostEst = gasCostUsd(candidate, ethPriceUsd);
  const netProfitEst = projectedProfitUsd(candidate, ethPriceUsd);
  if (netProfitEst < config.minProfitForecastUsd) {
    return `net profit $${netProfitEst.toFixed(2)} < $${config.minProfitForecastUsd}`;
  }
  if (gasCostEst / netProfitEst > config.gasCostPctOfProfitMax) {
    return `gas ratio ${(gasCostEst / netProfitEst).toFixed(2)} > ${config.gasCostPctOfProfitMax}`;
  }
  return null;
}

function logExecution(result: { success: boolean; txHash?: `0x${string}`; gasUsed?: bigint; error?: string }, stats: ScanStats) {
  if (result.success) {
    console.log(`    ✅ EXECUTED ${result.txHash?.slice(0,10)} gas=${result.gasUsed}`);
    stats.executed++;
  } else {
    console.log(`    ❌ FAILED: ${result.error}`);
    if (result.error?.includes("revert") || result.error?.includes("unwind")) stats.reverted++;
    else stats.failed++;
  }
}

function printStats(stats: ScanStats, jevStats: { totalCalls: number; totalCostUsd: number }) {
  const elapsed = (Date.now() - stats.startTime) / 1000 / 60;
  console.log(`\n--- STATS (${elapsed.toFixed(1)}m) ---`);
  console.log(`  Found: ${stats.candidatesFound} | Evaluated: ${stats.candidatesEvaluated}`);
  console.log(`  Jev: EXECUTE=${stats.jevExecute} QUEUE=${stats.jevQueue} SKIP=${stats.jevSkip}`);
  console.log(`  Executed: ${stats.executed} Reverted: ${stats.reverted} Failed: ${stats.failed}`);
  console.log(`  Jev calls: ${jevStats.totalCalls} | Cost: $${jevStats.totalCostUsd.toFixed(4)}`);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
