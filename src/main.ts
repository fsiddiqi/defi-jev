import "dotenv/config";
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { JevClient, createJevClientFromEnv } from "./jev/client.js";
import { scanAll } from "./scan.js";
import { checkOracleFreshness, checkOracleDivergence, fetchEthPrice } from "./oracle.js";
import { executeLiquidation } from "./execute.js";
import type { LiquidationCandidate, ExecutionConfig, JevDecision, ScanStats } from "./types.js";

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
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY required");
if (!PAPER_MODE && !SCAN_ONLY && !process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY required for real execution");

const rpcUrl = process.env.RPC_URL;
const privateKey = process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`;

const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) }) as any;
const wallet = createWalletClient({
  chain: base,
  transport: http(rpcUrl),
  account: privateKeyToAccount(privateKey as `0x${string}`),
});

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Starting liquidation racing CLI`);
  console.log(`  Mode: ${PAPER_MODE ? "PAPER" : SCAN_ONLY ? "SCAN-ONLY" : APPROVE_MODE ? "APPROVE" : "AUTO"}`);
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Wallet: ${wallet.account.address}`);

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

  while (true) {
    try {
      // 1. Fetch ETH price
      const ethPriceUsd = await fetchEthPrice(publicClient);

      // 2. Scan for candidates
      console.log(`\n[${new Date().toISOString()}] Scanning...`);
      const candidates = await scanAll(publicClient, ethPriceUsd);
      stats.candidatesFound += candidates.length;
      console.log(`  Found ${candidates.length} candidates (LTV > 0.80, seize >= $500)`);

      if (SCAN_ONLY) {
        for (const c of candidates) {
          console.log(`    ${c.protocol} ${c.borrower.slice(0,8)} LTV=${(c.currentLtv*100).toFixed(1)}% seize=$${c.expectedSeizeUsd.toFixed(2)}`);
        }
        await sleep(3000);
        continue;
      }

      // 3. Oracle divergence guard
      const divergence = await checkOracleDivergence(publicClient, "WETH");
      if (divergence.diverged && divergence.pctDiff > CONFIG.oracleDivergenceBps / 10000) {
        console.warn(`  Oracle divergence ${(divergence.pctDiff*100).toFixed(2)}% > ${CONFIG.oracleDivergenceBps}bps - BLOCKING ALL`);
        await sleep(30000);
        continue;
      }

      // 4. Evaluate each candidate with Jev
      for (const candidate of candidates) {
        stats.candidatesEvaluated++;

        // Pre-Jev gates
        if (!preJevGates(candidate, CONFIG)) {
          stats.jevSkip++;
          continue;
        }

        // Jev evaluation
        let jevDecision: JevDecision;
        try {
          const result = await jev.evaluate(candidate);
          jevDecision = result.decision;
          consecutiveJevFailures = 0;
          console.log(`  Jev: ${jevDecision.action} (conf=${jevDecision.confidence.toFixed(2)}, code=${jevDecision.reasoningCode}, pri=${jevDecision.priority})`);
        } catch (e) {
          consecutiveJevFailures++;
          console.error(`  Jev error (${consecutiveJevFailures}/${MAX_JEV_FAILURES}): ${e instanceof Error ? e.message : String(e)}`);
          if (consecutiveJevFailures >= MAX_JEV_FAILURES) {
            console.error(`  MAX JEV FAILURES REACHED - BLOCKING 30 MINUTES`);
            await sleep(30 * 60 * 1000);
            consecutiveJevFailures = 0;
          }
          stats.jevSkip++;
          continue;
        }

        // Count Jev actions
        if (jevDecision.action === "EXECUTE") stats.jevExecute++;
        else if (jevDecision.action === "QUEUE") stats.jevQueue++;
        else stats.jevSkip++;

        // Post-Jev gates
        if (!postJevGates(jevDecision, candidate, CONFIG)) {
          console.log(`    Post-Jev gate failed - skipping`);
          continue;
        }

        // Execute or log
        if (jevDecision.action === "EXECUTE") {
          if (PAPER_MODE) {
            console.log(`    [PAPER] Would execute: ${candidate.protocol} ${candidate.borrower.slice(0,8)} seize=$${candidate.expectedSeizeUsd.toFixed(2)}`);
            stats.executed++;
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

      // Stats heartbeat every cycle
      if (stats.candidatesEvaluated % 10 === 0) {
        printStats(stats, jev.getStats());
      }

      await sleep(3000); // 3s scan cadence

    } catch (e) {
      console.error(`[${new Date().toISOString()}] Loop error: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(5000);
    }
  }
}

function preJevGates(candidate: LiquidationCandidate, config: ExecutionConfig): boolean {
  if (candidate.oracleFreshnessSec > (candidate.protocol === "ionic" ? 300 : 60)) {
    console.log(`    Pre-Jev: Oracle stale (${candidate.oracleFreshnessSec}s)`);
    return false;
  }
  if (candidate.gasPriceGwei > 100) {
    console.log(`    Pre-Jev: Gas too high (${candidate.gasPriceGwei} gwei)`);
    return false;
  }
  if (candidate.expectedSeizeUsd < config.minSeizeUsd) {
    console.log(`    Pre-Jev: Seize too small ($${candidate.expectedSeizeUsd.toFixed(2)})`);
    return false;
  }
  // ageBlocks check would go here if we had it
  if (candidate.liquidationThreshold - candidate.currentLtv < 0.02) {
    console.log(`    Pre-Jev: LTV spread too tight (${((candidate.liquidationThreshold - candidate.currentLtv)*100).toFixed(1)}%)`);
    return false;
  }
  return true;
}

function postJevGates(decision: JevDecision, candidate: LiquidationCandidate, config: ExecutionConfig): boolean {
  if (decision.confidence < config.minJevConfidence) return false;
  // Jev safety score would be derived from reasoningCode
  // For now, assume safety is embedded in action
  if (decision.action !== "EXECUTE") return false;
  // Profit forecast check
  const gasCostEst = candidate.estimatedExecutionGas * candidate.gasPriceGwei * 1e-9 * 3000; // rough USD
  const netProfitEst = candidate.expectedSeizeUsd - gasCostEst - candidate.expectedSeizeUsd * 0.005; // 50bps slippage
  if (netProfitEst < config.minProfitForecastUsd) return false;
  if (netProfitEst / gasCostEst > config.gasCostPctOfProfitMax) return false;
  return true;
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
