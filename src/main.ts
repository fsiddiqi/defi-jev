import "dotenv/config";
import { createPublicClient, createWalletClient, fallback, http, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createJevClientFromEnv } from "./jev/client.js";
import { buildChainClients, scanAll } from "./scan.js";
import { checkOracleDivergence, fetchEthPrice } from "./oracle.js";
import { executeLiquidation, type LoopDeps } from "./execute.js";
import { buildExecutionTarget } from "./lib/target.js";
import { loadBudget, DAY_KEY, type BudgetConfig, type BudgetState } from "./lib/budget.js";
import { CHAINS, SCANNED_CHAIN_IDS, EXECUTABLE_CHAIN_IDS, isExecutableChain } from "./lib/chains.js";
import { readGate, gateEligible, runSelfTest, GATE_FILE, BUDGET_FILE, type SelfTestDeps } from "./self-test.js";
import type { LiquidationCandidate, ExecutionConfig, JevDecision, ScanStats } from "./types.js";
import { startServer, getState, addFeedEntry, updateFeedEntry, feedKey } from "./server.js";
import { ETH_USD_ASSUMED, gasCostUsd, projectedProfitUsd, exitCapUsd, salePriceRatio } from "./profit.js";
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

// Same (borrower, market) key for the Jev cache and decision map.
const candidateKey = (c: LiquidationCandidate) => feedKey(feedRow(c));

// Jev gate mode: "confidence" (TypeSafe confidence) or "probability" (p(EXECUTE))
const JEV_GATE_MODE = process.env.JEV_GATE_MODE ?? "probability";
const MIN_JEV_CONFIDENCE = Number(process.env.MIN_JEV_CONFIDENCE ?? "0.55");
const MIN_JEV_EXECUTE_PROB = Number(process.env.MIN_JEV_EXECUTE_PROB ?? "0.40");

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

// ── modes ─────────────────────────────────────────────────────────────────────
const MODE = process.argv.includes("--self-test")
  ? "SELF-TEST"
  : process.argv.includes("--scan-only")
    ? "SCAN-ONLY"
    : process.argv.includes("--paper")
      ? "PAPER"
      : "AUTO";
const SELF_TEST_DRY = process.argv.includes("--dry");
const NO_AUTO_GATE = process.argv.includes("--no-auto-gate");

if (!process.env.RPC_URL) throw new Error("RPC_URL required");
if (MODE !== "SCAN-ONLY" && MODE !== "SELF-TEST" && !process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY required for execution modes");
if (MODE !== "SCAN-ONLY" && MODE !== "SELF-TEST" && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY required");

const rpcUrl = process.env.RPC_URL;
const privateKey = process.env.PRIVATE_KEY
  ? (process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`
  : undefined;
const sendRpc = process.env.SEND_RPC ?? "https://base.drpc.org";

// Reads: primary RPC with public fallbacks (free endpoints rate-limit under
// scanning + oracle loads). Sends: a dedicated, reliable endpoint only.
const publicTransport = fallback([http(rpcUrl), http("https://base-rpc.publicnode.com"), http("https://1rpc.io/base")]);
const publicClient = createPublicClient({ chain: base, transport: publicTransport }) as PublicClient;
const wallet = privateKey ? createWalletClient({
  chain: base,
  transport: http(sendRpc),
  account: privateKeyToAccount(privateKey as `0x${string}`),
}) : undefined;

const MORPHO = (process.env.MORPHO_BLUE_ADDRESS ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb") as `0x${string}`;
const LIQUIDATOR = (process.env.FLASH_LIQUIDATOR ?? "") as `0x${string}`;
const BUDGET: BudgetConfig = {
  txCapUsd: Number(process.env.MAX_GAS_USD_PER_TX ?? "2"),
  dayCapUsd: Number(process.env.MAX_GAS_USD_PER_DAY ?? "10"),
  file: BUDGET_FILE,
};
const rpcLabel = `base:${sendRpc.replace(/^https?:\/\//, "").split("/")[0]}`;

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] defi-jev  mode=${MODE}`);
  console.log(`  read RPC:   ${rpcUrl}  (fallbacks: publicnode, 1rpc)`);
  console.log(`  send RPC:   ${sendRpc}`);
  console.log(`  wallet:     ${wallet?.account.address ?? "(none)"}`);
  console.log(`  executor:   ${LIQUIDATOR || "(not configured — deploy MorphoFlashLiquidator)"}`);

  const state = getState();
  state.mode = MODE;
  state.running = true;
  state.startTime = Date.now();
  state.executor = {
    contract: LIQUIDATOR || null,
    owner: wallet?.account.address ?? null,
    chainId: base.id,
    chains: [...EXECUTABLE_CHAIN_IDS],
    status: "idle",
  };
  state.scannedChains = SCANNED_CHAIN_IDS;

  // The AUTO gate: read the persisted self-test record and the budget ledger,
  // surface both in the UI before anything else happens.
  const gate = readGate();
  const budget = loadBudget(BUDGET);
  state.selfTestGate = {
    passed: gate.passed,
    settled: gate.settled,
    at: gate.at,
    txHash: gate.txHash,
    chainId: gate.chainId,
    keeperProbeReverted: gate.keeperProbeReverted,
    costUsd: gate.gasCostUsd,
    error: gate.error,
  };
  state.gasBudget = budgetToUi(BUDGET, budget);

  if (MODE === "SELF-TEST") {
    if (!wallet) throw new Error("--self-test needs PRIVATE_KEY");
    if (!LIQUIDATOR) throw new Error("--self-test needs FLASH_LIQUIDATOR (deployed executor address)");
    startServer(Number(process.env.UI_PORT ?? 3000), process.env.UI_HOST ?? "0.0.0.0");
    const ethPriceUsd = await fetchEthPrice(publicClient).catch(() => ETH_USD_ASSUMED);
    state.ethPriceUsd = ethPriceUsd;
    const deps: SelfTestDeps = {
      publicClient, wallet, owner: wallet.account.address,
      liquidator: LIQUIDATOR, morpho: MORPHO, rpcLabel,
      ethPriceUsd, budget: BUDGET,
    };
    const result = await runSelfTest(deps, { dry: SELF_TEST_DRY });
    const g = readGate();
    state.selfTestGate = {
      passed: g.passed, settled: g.settled, at: g.at, txHash: g.txHash, chainId: g.chainId,
      keeperProbeReverted: g.keeperProbeReverted, costUsd: g.gasCostUsd, error: g.error,
    };
    state.idleReason = result.passed
      ? SELF_TEST_DRY ? "self-test DRY-run prove (no tx sent)" : "self-test gate PASSED — AUTO is armed"
      : result.dry
        ? "self-test DRY-run prove passed — gate NOT armed (run `npm run self-test` to arm AUTO)"
        : `self-test FAILED — AUTO stays off: ${result.error}`;
    console.log(`\ngate status: ${result.passed ? "PASS" : result.dry ? "DRY-PROVE (not armed)" : "FAIL"} → ${state.idleReason}`);
    // A dry run that completed its proof is a successful dev-loop step even
    // though it must not arm AUTO (exit 1 would break the dev loop sequence).
    process.exit(result.passed || result.dry ? 0 : 1);
  }

  if (MODE === "AUTO" && !NO_AUTO_GATE) {
    const eligible = gateEligible(gate, LIQUIDATOR, base.id);
    if (!eligible.ok) {
      console.error(`\n✗ AUTO gated off: ${eligible.reason}`);
      console.error(`  → run \`npm run self-test\` (or --no-auto-gate for a dev override)`);
      process.exit(1);
    }
    console.log(`\n✓ AUTO gate passed (self-test ${gate.txHash?.slice(0, 10)}… on chain ${gate.chainId}, keeper-proof ${gate.keeperProbeReverted})`);
  }

  startServer(Number(process.env.UI_PORT ?? 3000), process.env.UI_HOST ?? "0.0.0.0");

  // Read clients per scanned chain (stateless; reused across cycles).
  const chainClients = buildChainClients();
  // Jev is only created in modes that actually consult the model — scan-only
  // must run with zero Jev dependency (no key required, no tokens touched).
  const jev = MODE === "SCAN-ONLY" ? null : createJevClientFromEnv();
  const loopDeps: LoopDeps | null = wallet ? {
    publicClient,
    wallet,
    morpho: MORPHO,
    liquidator: LIQUIDATOR,
    owner: wallet.account.address,
    rpcLabel,
    ethPriceUsd: ETH_USD_ASSUMED, // refreshed every cycle; fallback used by executor only
    budget: BUDGET,
  } : null;

  const stats: ScanStats = {
    candidatesFound: 0,
    candidatesEvaluated: 0,
    jevExecute: 0,
    jevQueue: 0,
    jevSkip: 0,
    jevJudged: 0,
    jevExecuteRefusedByOnChain: 0,
    jevExecuteSettled: 0,
    executed: 0,
    reverted: 0,
    failed: 0,
    startTime: Date.now(),
  };

  let consecutiveJevFailures = 0;
  const MAX_JEV_FAILURES = 3;
  let cycleCount = 0;

  const JEV_REEVAL_MS = Number(process.env.JEV_REEVAL_SEC ?? "1800") * 1000;
  const jevCache = new Map<string, { decision: JevDecision; at: number; contextHash: string }>();
  const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? "30000");
  state.scanIntervalMs = SCAN_INTERVAL_MS;

  const WATCH_PLAYABLE: WatchPlayableConfig = {
    capUsd: Number(process.env.WATCH_PLAYABLE_CAP_USD ?? "250000"),
    minProfitUsd: Number(process.env.WATCH_MIN_PROFIT_USD ?? "500"),
    maxOracleAgeSec: Number(process.env.WATCH_ORACLE_MAX_AGE_SEC ?? "300"),
  };
  state.playable = { ...WATCH_PLAYABLE };

  const JEV_BATCH_SIZE = Number(process.env.JEV_BATCH_SIZE ?? "64");
  const JEV_MIN_INTERVAL_MS = Number(process.env.JEV_MIN_INTERVAL_MS ?? "120000");
  let lastJevCallAt = 0;
  let knownGoodBatch = JEV_BATCH_SIZE;

  const pauseUntilNextScan = async (ms: number): Promise<void> => {
    state.nextScanAt = Date.now() + ms;
    await sleep(ms);
  };

  while (true) {
    try {
      const ethPriceUsd = MODE === "SCAN-ONLY" ? 2700 : await fetchEthPrice(publicClient).catch(() => ETH_USD_ASSUMED);
      state.ethPriceUsd = ethPriceUsd;
      if (loopDeps) loopDeps.ethPriceUsd = ethPriceUsd;

      console.log(`\n[${new Date().toISOString()}] Scanning...`);
      state.lastScanAt = new Date().toISOString();
      state.executor && (state.executor.status = "scanning");
      const candidates = await scanAll(chainClients, ethPriceUsd);
      state.executor && (state.executor.status = "idle");
      stats.candidatesFound += candidates.length;
      state.stats = { ...stats };
      state.jevStats = jev?.getStats() ?? null;
      console.log(`  Found ${candidates.length} candidates (seize >= $${CONFIG.minSeizeUsd})`);

      if (MODE === "SCAN-ONLY") {
        for (const c of candidates) {
          console.log(`    [${CHAINS[c.chainId]?.name ?? c.chainId}] ${c.borrower.slice(0, 8)} LTV=${(c.currentLtv * 100).toFixed(1)}% seize=$${c.expectedSeizeUsd.toFixed(2)} profit=$${projectedProfitUsd(c, ethPriceUsd).toFixed(2)}`);
        }
        await pauseUntilNextScan(3000);
        continue;
      }

      const divergence = await checkOracleDivergence(publicClient, "WETH");
      if (divergence.diverged && divergence.pctDiff > CONFIG.oracleDivergenceBps / 10000) {
        console.warn(`  Oracle divergence ${(divergence.pctDiff * 100).toFixed(2)}% > ${CONFIG.oracleDivergenceBps}bps - BLOCKING ALL`);
        state.idleReason = `oracle divergence ${(divergence.pctDiff * 100).toFixed(2)}% — all execution blocked`;
        await pauseUntilNextScan(30000);
        continue;
      }

      let cachedJevDecisions = 0;
      const eligible: LiquidationCandidate[] = [];
      const decisionOf = new Map<string, JevDecision>();

      for (const candidate of candidates) {
        stats.candidatesEvaluated++;

        addFeedEntry({
          timestamp: new Date().toISOString(),
          protocol: candidate.protocol,
          chainId: candidate.chainId,
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

        // Discovery is wider than execution: chains without a wired executor
        // (liquidator deployed + self-test gate passed) are shown in the feed
        // but blocked BEFORE Jev with the honest reason — no token spend on
        // positions the bot cannot act on.
        if (!isExecutableChain(candidate.chainId)) {
          const cname = CHAINS[candidate.chainId]?.name ?? String(candidate.chainId);
          updateFeedEntry(feedRow(candidate), {
            gateResult: "blocked",
            gateReason: `chain ${cname} not executable (no wired executor there) — discovery only`,
          });
          continue;
        }

        if (candidate.watch && !isWatchPlayable(candidate, WATCH_PLAYABLE, ethPriceUsd)) {
          updateFeedEntry(feedRow(candidate), {
            gateResult: "watch",
            gateReason: "at-risk, not playable (size / profit floor / oracle age) - not judged",
            playable: false,
          });
          continue;
        }

        const preJev = candidate.watch ? { pass: true as const, reason: "" } : preJevGates(candidate, CONFIG);
        if (!preJev.pass) {
          stats.jevSkip++;
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: `pre-Jev: ${preJev.reason}` });
          state.stats = { ...stats };
          console.log(`    Pre-Jev: ${preJev.reason}`);
          continue;
        }

        const integrity = dataIntegrityGate(candidate, Number(process.env.MAX_HF_MISMATCH_PCT ?? "0.30"));
        if (!integrity.pass) {
          stats.jevSkip++;
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: integrity.reason });
          state.stats = { ...stats };
          console.log(`    Data-integrity gate: ${integrity.reason} - skipping ${candidate.borrower.slice(0, 8)}`);
          continue;
        }

        const cached = jevCache.get(candidateKey(candidate));
        const ctxHash = candidateContextHash(candidate);
        if (cached && (Date.now() - cached.at < JEV_REEVAL_MS || cached.contextHash === ctxHash)) {
          decisionOf.set(candidateKey(candidate), cached.decision);
          cachedJevDecisions++;
        }
        eligible.push(candidate);
      }

      const fresh = eligible.filter((c) => !decisionOf.has(candidateKey(c)));
      let apiCalls = 0;
      // jev is null only in SCAN-ONLY, which returns above — reaching here
      // means the model client exists (guarded for the type checker).
      if (!jev) continue;
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
              // Audit line: the deterministic facts Jev's verdict is measured
            // against. "redundant" = rules would block this anyway (cap/0-profit);
            // System One only earns its keep on rows where rules pass.
            const capUsd = exitCapUsd(candidate.exitLiquidityUsd);
            const ratio = candidate.dexPriceUsd !== null ? salePriceRatio(candidate) : null;
            const rulesViable = capUsd >= candidate.expectedSeizeUsd && projectedProfitUsd(candidate, ethPriceUsd) > 0;
            console.log(
              `  Jev: ${d.action} (conf=${d.confidence.toFixed(2)}, code=${d.reasoningCode}, pri=${d.priority}, sanity=${d.sanity}) ${candidate.borrower.slice(0, 8)} seize=$${candidate.expectedSeizeUsd.toFixed(0)} | rules: cap=$${capUsd.toFixed(0)} dex/oracle=${ratio !== null ? ratio.toFixed(3) : "-"} profit=$${projectedProfitUsd(candidate, ethPriceUsd).toFixed(0)} ${rulesViable ? "" : "[rules-viable=no]"}`,
            );
            });
            apiCalls++;
            evaluated += chunk.length;
            knownGoodBatch = batchSize;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (batchSize > 1) {
              batchSize = Math.max(1, Math.floor(batchSize / 2));
              knownGoodBatch = Math.min(knownGoodBatch, batchSize);
              console.warn(`  Jev batch error (${msg}) - halving batch size to ${batchSize}`);
              continue;
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

        if (candidate.watch) {
          updateFeedEntry(feedRow(candidate), {
            gateResult: "watch",
            gateReason: `HF ${candidate.healthFactor.toFixed(4)} (not liquidatable) · Jev warm: ${jevDecision.action}`,
            playable: isWatchPlayable(candidate, WATCH_PLAYABLE, ethPriceUsd),
          });
          if (jevDecision.action === "EXECUTE") {
            console.log(`    [watch] ${candidate.borrower.slice(0, 8)} ${candidate.collateralAsset} HF=${candidate.healthFactor.toFixed(4)} — Jev: EXECUTE-worthy if liquidatable (profit=$${projectedProfitUsd(candidate, ethPriceUsd).toFixed(2)})`);
          }
          continue;
        }

        if (jevDecision.action === "EXECUTE") stats.jevExecute++;
        else if (jevDecision.action === "QUEUE") stats.jevQueue++;
        else stats.jevSkip++;
        stats.jevJudged++;
        state.stats = { ...stats };

        const gateFail = postJevGates(jevDecision, candidate, CONFIG, ethPriceUsd);
        if (gateFail) {
          updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: gateFail });
          state.idleReason = gateFail;
          if (jevDecision.action === "EXECUTE") {
            console.log(`    Post-Jev gate failed (${gateFail}) - skipping ${candidate.borrower.slice(0, 8)}`);
          }
          continue;
        }
        updateFeedEntry(feedRow(candidate), { gateResult: "passed" });

        if (jevDecision.action === "EXECUTE") {
          if (MODE === "PAPER") {
            console.log(`    [PAPER] Would execute: ${candidate.borrower.slice(0, 8)} ${candidate.collateralAsset}→${candidate.borrowAsset} seize=$${candidate.expectedSeizeUsd.toFixed(2)} profit=$${projectedProfitUsd(candidate, ethPriceUsd).toFixed(2)}`);
            stats.executed++;
            updateFeedEntry(feedRow(candidate), { executed: true, gateReason: "paper — logged only" });
            continue;
          }

          // AUTO: build the execution target from FRESH on-chain truth + a real
          // exit quote. Any failure here is the honest last line of defense —
          // Jev's decision is advisory; only a real quote can sign a real tx.
          if (!loopDeps) { stats.failed++; continue; }
          state.executor && (state.executor.status = "simulating");
          const built = await buildExecutionTarget(publicClient, rpcLabel, MORPHO, candidate, ethPriceUsd, CONFIG);
          if (!built.ok) {
            stats.failed++;
            stats.jevExecuteRefusedByOnChain++; // System One said EXECUTE, System Two said no
            state.idleReason = built.reason;
            updateFeedEntry(feedRow(candidate), { gateResult: "blocked", gateReason: `on-chain: ${built.reason}` });
            console.log(`    💤 On-chain refusal: ${built.reason}`);
            continue;
          }
          state.executor && (state.executor.status = "sending");
          const result = await executeLiquidation(loopDeps, built.target);
          state.executor && (state.executor.status = "idle");

          // Refresh the budget ledger for the UI after any spend (success or fail).
          state.gasBudget = budgetToUi(BUDGET, loadBudget(BUDGET));
          state.lastExecution = {
            at: new Date().toISOString(),
            kind: "liquidation",
            txHash: result.txHash ?? null,
            success: result.success,
            profitUsd: result.profitUsd ?? null,
            gasUsd: result.gasCostUsd ?? null,
            note: (result.success ? built.target.reason : result.error) ?? null,
          };
          if (result.success) {
            stats.jevExecuteSettled++;
            updateFeedEntry(feedRow(candidate), {
              executed: true,
              executedForReal: true,
              gateResult: "passed",
              gateReason: `on-chain: ${result.txHash?.slice(0, 10)}… profit ${result.profitUsd != null ? "$" + result.profitUsd.toFixed(2) : "?"}`,
            });
          } else {
            updateFeedEntry(feedRow(candidate), {
              gateResult: "blocked",
              gateReason: `execution failed: ${result.error}`,
            });
          }
          logExecution(result, stats, built.target.reason);
        }
      }

      cycleCount++;
      const nowMs = Date.now();
      state.cycle = cycleCount;
      state.jevApiCallsLastCycle = apiCalls;
      if (fresh.length > 0) {
        state.lastJevBatchAt = new Date(nowMs).toISOString();
        state.nextJevRefreshAt = nowMs + JEV_REEVAL_MS;
      }
      const jevTotal = jev?.getStats() ?? { totalCalls: 0, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0 };
      const uptimeMin = ((nowMs - state.startTime) / 60000).toFixed(1);
      const refreshIn = state.nextJevRefreshAt ? Math.max(0, Math.ceil((state.nextJevRefreshAt - nowMs) / 1000)) : 0;
      const callsPerHr = jevTotal.totalCalls > 0
        ? Math.round(jevTotal.totalCalls / (Math.max(1, nowMs - state.startTime) / 3600000))
        : 0;
      const tokensPerHr = jevTotal.totalTokensIn > 0
        ? Math.round(jevTotal.totalTokensIn / (Math.max(1, nowMs - state.startTime) / 3600000))
        : 0;
      console.log(`  [status] cycle=${cycleCount} uptime=${uptimeMin}min | chains=${SCANNED_CHAIN_IDS.length} scanned/${EXECUTABLE_CHAIN_IDS.size} executable | candidates=${candidates.length} jev=${apiCalls} call(s) (${fresh.length} fresh, ${cachedJevDecisions} cached) | total=${jevTotal.totalCalls} calls, ${(jevTotal.totalTokensIn / 1000).toFixed(0)}K tokens in (${(tokensPerHr / 1000).toFixed(0)}K/hr, ~${callsPerHr}/hr) | next jev refresh in ${refreshIn}s | gas budget $${state.gasBudget?.spentUsd.toFixed(2)}/${state.gasBudget?.capUsd.toFixed(2)}`);

      if (stats.candidatesEvaluated % 10 === 0) {
        printStats(stats, jev?.getStats() ?? { totalCalls: 0, totalCostUsd: 0 });
      }
      state.stats = { ...stats };
      state.jevStats = jevTotal;

      await pauseUntilNextScan(SCAN_INTERVAL_MS);

    } catch (e) {
      console.error(`[${new Date().toISOString()}] Loop error: ${e instanceof Error ? e.message : String(e)}`);
      state.idleReason = e instanceof Error ? e.message : String(e);
      await pauseUntilNextScan(5000);
    }
  }
}

function budgetToUi(cfg: BudgetConfig, b: BudgetState) {
  return {
    capUsd: cfg.dayCapUsd,
    spentUsd: b.daySpentUsd,
    attempts: b.dayAttempts,
    failed: b.dayFailed,
    lastTxAt: b.lastTxAt,
    lastTxHash: b.lastTxHash,
    lastTxStatus: b.lastTxStatus,
    lastTxGasUsd: b.lastTxGasUsd,
    lastTxProfitUsd: b.lastTxProfitUsd,
  };
}

// Returns null when the candidate passes, otherwise the reason it was blocked.
function postJevGates(decision: JevDecision, candidate: LiquidationCandidate, config: ExecutionConfig, ethPriceUsd: number = ETH_USD_ASSUMED): string | null {
  if (decision.action !== "EXECUTE") return `jev action ${decision.action}`;
  const executeProb = decision.actionProbabilities.EXECUTE ?? 0;
  if (JEV_GATE_MODE === "probability") {
    if (executeProb < MIN_JEV_EXECUTE_PROB) {
      return `jev p(EXECUTE) ${executeProb.toFixed(2)} < ${MIN_JEV_EXECUTE_PROB}`;
    }
  } else {
    if (decision.confidence < config.minJevConfidence) {
      return `jev confidence ${decision.confidence.toFixed(2)} < ${config.minJevConfidence}`;
    }
  }
  if (process.env.JEV_SANITY_GATE !== "false" && decision.sanity !== "plausible") {
    const pct = (decision.sanityConfidence * 100).toFixed(0);
    return `jev sanity: ${decision.sanity} (${pct}%)`;
  }
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

function logExecution(result: { success: boolean; txHash?: `0x${string}`; gasUsed?: bigint; error?: string }, stats: ScanStats, note?: string) {
  if (result.success) {
    console.log(`    ✅ EXECUTED ${result.txHash}  gas=${result.gasUsed}  (${note ?? ""})`);
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
  console.log(`  Jev: EXECUTE=${stats.jevExecute} QUEUE=${stats.jevQueue} SKIP=${stats.jevSkip} (judged past all rules: ${stats.jevJudged})`);
  console.log(`  One vs Two: EXECUTE refused by on-chain quote/sim=${stats.jevExecuteRefusedByOnChain} | settled=${stats.jevExecuteSettled}`);
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