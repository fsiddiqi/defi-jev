// Does the quantized context hash actually stay stable across scans?
// Run scanAll twice, compare (old raw hash vs new quantized hash) per candidate.
import "dotenv/config";
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { scanAll } from "../src/scan.js";
import { fetchEthPrice } from "../src/oracle.js";
import { candidateContextHash } from "../src/lib/scanMath.js";
import type { LiquidationCandidate } from "../src/types.js";

// The pre-fix hash (raw fields, full precision) for comparison.
function legacyHash(c: LiquidationCandidate): string {
  const inputs = [
    c.protocol, c.borrower, c.collateralAsset, c.collateralTier, c.borrowAsset,
    c.currentLtv.toFixed(6), c.liquidationThreshold.toFixed(6), c.healthFactor.toFixed(9),
    c.collateralBalanceUsd.toFixed(4), c.borrowBalanceUsd.toFixed(4), c.expectedSeizeUsd.toFixed(4),
    c.oracleFreshnessSec, c.gasPriceGwei.toFixed(6), c.estimatedExecutionGas,
    c.recentPriceMovePct30m.toFixed(6), c.cascadeScore.toFixed(6),
    c.competitionLast10Blocks, c.ageBlocks, c.priceSource,
    c.oracleAgeSec ?? "nil", c.dexPriceUsd?.toFixed(10) ?? "nil",
    c.exitLiquidityUsd?.toFixed(4) ?? "nil", c.oraclePriceUsd?.toFixed(10) ?? "nil",
    c.saleVenue ?? "nil", c.watch ? "watch" : "live",
  ].join("|");
  let h = 5381;
  for (let i = 0; i < inputs.length; i++) h = ((h << 5) + h + inputs.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const key = (c: LiquidationCandidate) => `${c.borrower}|${c.collateralAsset}|${c.borrowAsset}`;
const rpcUrl = process.env.RPC_URL!;
const publicClient = createPublicClient({
  chain: base,
  transport: fallback([http(rpcUrl), http("https://base-rpc.publicnode.com")]),
}) as any;

const scan = async () => {
  const rows = await scanAll(publicClient, await fetchEthPrice(publicClient));
  return new Map(rows.map((c) => [key(c), c]));
};

const a = await scan();
console.log(`scan A: ${a.size} candidates — sleeping 45s`);
await new Promise((r) => setTimeout(r, 45_000));
const b = await scan();
console.log(`scan B: ${b.size} candidates\n`);

let shared = 0, newStable = 0, oldStable = 0;
for (const [k, ca] of a) {
  const cb = b.get(k);
  if (!cb) continue;
  shared++;
  if (candidateContextHash(ca) === candidateContextHash(cb)) newStable++;
  if (legacyHash(ca) === legacyHash(cb)) oldStable++;
}
console.log(`candidates present in BOTH scans: ${shared}`);
console.log(`old raw hash:  ${oldStable}/${shared} stable (${((oldStable / Math.max(1, shared)) * 100).toFixed(0)}%) — the rest were re-judged`);
console.log(`new quantized: ${newStable}/${shared} stable (${((newStable / Math.max(1, shared)) * 100).toFixed(0)}%) — the rest were re-judged`);
