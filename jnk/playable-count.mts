// How many of the scanned candidates are actually sent to Jev after the
// "playable watch rows only" trim?
import "dotenv/config";
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { scanAll } from "../src/scan.js";
import { fetchEthPrice } from "../src/oracle.js";
import { isWatchPlayable, type WatchPlayableConfig } from "../src/lib/watch.js";

const PLAYABLE: WatchPlayableConfig = {
  capUsd: Number(process.env.WATCH_PLAYABLE_CAP_USD ?? "250000"),
  minProfitUsd: Number(process.env.WATCH_MIN_PROFIT_USD ?? "500"),
  maxOracleAgeSec: Number(process.env.WATCH_ORACLE_MAX_AGE_SEC ?? "300"),
};

const rpcUrl = process.env.RPC_URL!;
const publicClient = createPublicClient({
  chain: base,
  transport: fallback([http(rpcUrl), http("https://base-rpc.publicnode.com")]),
}) as any;

const eth = await fetchEthPrice(publicClient);
const rows = await scanAll(publicClient, eth);
const watch = rows.filter((c) => c.watch);
const live = rows.filter((c) => !c.watch);
const playableWatch = watch.filter((c) => isWatchPlayable(c, PLAYABLE, eth));

console.log(`\ntotal candidates:            ${rows.length}`);
console.log(`  liquidatable (always sent): ${live.length}`);
console.log(`  at-risk watch:             ${watch.length}`);
console.log(`    playable (sent):         ${playableWatch.length}`);
console.log(`    not playable (skipped):  ${watch.length - playableWatch.length}`);
console.log(`=> sent to Jev: ${live.length + playableWatch.length} (was ${rows.length})`);
