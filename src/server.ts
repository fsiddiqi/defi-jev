import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiquidationCandidate, JevDecision, ScanStats } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

// ── Shared state (updated by main loop, read by HTTP server) ────────────────

export interface FeedEntry {
  timestamp: string;
  scans: number;
  protocol: string;
  chainId: number;
  borrower: string;
  collateralAsset: string;
  borrowAsset: string;
  currentLtv: number;
  healthFactor: number;
  expectedSeizeUsd: number;
  /** seize − est. gas − slippage (same math as the post-Jev profit gate) */
  projectedProfitUsd: number;
  gasPriceGwei: number;
  /** Exit price authority: oracle | dex | none (none = unrealizable, profit 0) */
  priceSource: "oracle" | "dex" | "none";
  exitLiquidityUsd: number | null;
  /** real Aerodrome spot, USD per collateral token (pool found), else null */
  dexPriceUsd: number | null;
  /** protocol liquidation price, USD per collateral token (from price()) */
  oraclePriceUsd: number | null;
  saleVenue: string | null;
  oracleAgeSec: number | null;
  decision: {
    action: string;
    confidence: number;
    /** P(EXECUTE) from Jev's full posterior — drives the feed's EV ranking */
    executeProb?: number;
    reasoningCode: string;
    priority: number;
    sanity?: string;
  } | null;
  gateResult: "passed" | "blocked" | "pending" | "watch" | null;
  gateReason?: string;
  executed?: boolean;
  /** true only when a REAL on-chain transaction settled (vs paper/dry) */
  executedForReal?: boolean;
  /** At-risk rows small enough + verifiable enough for a solo bot to play (see lib/watch.ts) */
  playable?: boolean;
}

export interface BotState {
  mode: string;
  running: boolean;
  startTime: number;
  ethPriceUsd: number;
  lastScanAt: string | null;
  /** Epoch ms when the next scan cycle starts (set just before each sleep) */
  nextScanAt: number | null;
  scanIntervalMs: number;
  candidatesFound: number;
  feed: FeedEntry[];
  stats: ScanStats | null;
  jevStats: { totalCalls: number; totalCostUsd: number; totalTokensIn: number; totalTokensOut: number } | null;
  lastJevBatchAt: string | null;
  nextJevRefreshAt: number | null;
  jevApiCallsLastCycle: number;
  cycle: number;
  playable: { capUsd: number; minProfitUsd: number; maxOracleAgeSec: number } | null;
  /** What the bot can ACTUALLY execute right now (real contract, not a promise) */
  executor: {
    contract: string | null;
    owner: string | null;
    chainId: number;
    chains: number[]; // chains with a wired executor (executable today)
    status: "idle" | "scanning" | "simulating" | "sending" | "waiting";
  } | null;
  /** Chains the scanner discovers on (net widened when idle) */
  scannedChains: number[];
  /** AUTO is gated behind a successful keeper-proof self-test (see lib notes) */
  selfTestGate: {
    passed: boolean;
    /** a real liquidation settled through the app's own executor (dry runs are never settled) */
    settled: boolean;
    at: string | null;
    txHash: string | null;
    chainId: number | null;
    keeperProbeReverted: boolean;
    costUsd: number | null;
    error: string | null;
  } | null;
  /** Gas budget ledger — the ceiling on unattended spending */
  gasBudget: {
    capUsd: number;
    spentUsd: number;
    attempts: number;
    failed: number;
    lastTxAt: string | null;
    lastTxHash: string | null;
    lastTxStatus: string | null;
    lastTxGasUsd: number;
    lastTxProfitUsd: number | null;
  } | null;
  /** Why the bot is not executing right now (honest idle reason) */
  idleReason: string | null;
  lastExecution: {
    at: string;
    kind: string;
    txHash: string | null;
    success: boolean;
    profitUsd: number | null;
    gasUsd: number | null;
    note: string | null;
  } | null;
}

const MAX_FEED = 600;

const state: BotState = {
  mode: "unknown",
  running: false,
  startTime: Date.now(),
  ethPriceUsd: 0,
  lastScanAt: null,
  nextScanAt: null,
  scanIntervalMs: 0,
  candidatesFound: 0,
  feed: [],
  stats: null,
  jevStats: null,
  lastJevBatchAt: null,
  nextJevRefreshAt: null,
  jevApiCallsLastCycle: 0,
  cycle: 0,
  playable: null,
  executor: null,
  scannedChains: [],
  selfTestGate: null,
  gasBudget: null,
  idleReason: null,
  lastExecution: null,
};

export function getState(): BotState {
  return state;
}

// A feed row is one (borrower, market) pair. A borrower with positions in two
// markets (e.g. USR and wbCOIN) must get two rows — keying by borrower alone
// made one market's venue/depth/decision overwrite the other's.
export function feedKey(c: { borrower: string; collateralAsset: string; borrowAsset: string }): string {
  return `${c.borrower.toLowerCase()}|${c.collateralAsset}|${c.borrowAsset}`;
}

export function addFeedEntry(entry: Omit<FeedEntry, "scans">): void {
  const key = feedKey(entry);
  const existing = state.feed.find((e) => feedKey(e) === key);
  if (existing) {
    // Same (borrower, market) seen again — bump scan count, refresh dynamic
    // fields, move to top. Keep the previous decision visible until the new
    // one lands.
    existing.scans++;
    existing.timestamp = entry.timestamp;
    existing.currentLtv = entry.currentLtv;
    existing.healthFactor = entry.healthFactor;
    existing.expectedSeizeUsd = entry.expectedSeizeUsd;
    existing.projectedProfitUsd = entry.projectedProfitUsd;
    existing.gasPriceGwei = entry.gasPriceGwei;
    existing.priceSource = entry.priceSource;
    existing.exitLiquidityUsd = entry.exitLiquidityUsd;
    existing.saleVenue = entry.saleVenue;
    existing.oracleAgeSec = entry.oracleAgeSec;
    existing.dexPriceUsd = entry.dexPriceUsd;
    existing.oraclePriceUsd = entry.oraclePriceUsd;
    state.feed = [existing, ...state.feed.filter((e) => e !== existing)];
  } else {
    state.feed.unshift({ ...entry, scans: 1 });
  }
  if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
}

export function updateFeedEntry(
  candidate: { borrower: string; collateralAsset: string; borrowAsset: string },
  updates: Partial<FeedEntry>,
): void {
  const entry = state.feed.find((e) => feedKey(e) === feedKey(candidate));
  if (entry) Object.assign(entry, updates);
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function startServer(port = 3456, host = "0.0.0.0"): void {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/status") {
      json(res, state);
      return;
    }

    // Serve static files
    let filePath = url === "/" ? "/index.html" : url;
    filePath = filePath.replace(/\.\./g, ""); // basic path traversal guard
    try {
      const data = await readFile(join(PUBLIC_DIR, filePath));
      const ext = filePath.slice(filePath.lastIndexOf("."));
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      json(res, { error: "not found" }, 404);
    }
  });

  server.listen(port, host, () => {
    console.log(`  UI: http://${host}:${port}`);
  });
}
