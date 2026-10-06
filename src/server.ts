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
  borrower: string;
  collateralAsset: string;
  borrowAsset: string;
  currentLtv: number;
  expectedSeizeUsd: number;
  /** seize − est. gas − 50bps slippage (same math as the post-Jev profit gate) */
  projectedProfitUsd: number;
  gasPriceGwei: number;
  decision: {
    action: string;
    confidence: number;
    reasoningCode: string;
    priority: number;
    sanity?: string;
  } | null;
  gateResult: "passed" | "blocked" | "pending" | null;
  gateReason?: string;
  executed?: boolean;
}

export interface BotState {
  mode: string;
  running: boolean;
  startTime: number;
  ethPriceUsd: number;
  lastScanAt: string | null;
  candidatesFound: number;
  feed: FeedEntry[];
  stats: ScanStats | null;
  jevStats: { totalCalls: number; totalCostUsd: number; totalTokensIn: number; totalTokensOut: number } | null;
  lastJevBatchAt: string | null;
  nextJevRefreshAt: number | null;
  jevApiCallsLastCycle: number;
  cycle: number;
}

const MAX_FEED = 100;

const state: BotState = {
  mode: "unknown",
  running: false,
  startTime: Date.now(),
  ethPriceUsd: 0,
  lastScanAt: null,
  candidatesFound: 0,
  feed: [],
  stats: null,
  jevStats: null,
  lastJevBatchAt: null,
  nextJevRefreshAt: null,
  jevApiCallsLastCycle: 0,
  cycle: 0,
};

export function getState(): BotState {
  return state;
}

export function addFeedEntry(entry: Omit<FeedEntry, "scans">): void {
  const existing = state.feed.find((e) => e.borrower === entry.borrower);
  if (existing) {
    // Same borrower seen again — bump scan count, refresh dynamic fields,
    // move to top. Keep the previous decision visible until the new one lands.
    existing.scans++;
    existing.timestamp = entry.timestamp;
    existing.currentLtv = entry.currentLtv;
    existing.expectedSeizeUsd = entry.expectedSeizeUsd;
    existing.projectedProfitUsd = entry.projectedProfitUsd;
    existing.gasPriceGwei = entry.gasPriceGwei;
    state.feed = [existing, ...state.feed.filter((e) => e !== existing)];
  } else {
    state.feed.unshift({ ...entry, scans: 1 });
  }
  if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
}

export function updateFeedEntry(
  borrower: string,
  updates: Partial<FeedEntry>,
): void {
  const entry = state.feed.find((e) => e.borrower === borrower);
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
