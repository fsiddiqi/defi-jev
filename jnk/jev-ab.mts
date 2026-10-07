// A/B: legacy payload (rule text repeated in every question's instructions)
// vs new payload (rule text once in state.rules, short per-question text).
// Same candidates, same model — do the decisions agree?
import "dotenv/config";
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { JevClient } from "../src/jev/client.js";
import { scanAll } from "../src/scan.js";
import { fetchEthPrice } from "../src/oracle.js";

type Mode = "new" | "legacy";
let mode: Mode = "new";
let lastBody: any = null;
const realFetch = globalThis.fetch;

const LEGACY_INSTR: Record<string, (rules: any) => string> = {
  action: (r) => r.action,
  reasoning: () =>
    "What is the single primary reason for this decision? Pick the code that best matches the decisive factor from the checklist.",
  priority: () =>
    "Priority for execution if it were approved (1=lowest, 10=highest). Driven first by projectedProfitUsd, then by ltvPastThresholdPct, low competition, and liquid/known collateral. Low priority also when upside is marginal.",
  sanity: (r) => r.sanity,
};

(globalThis as any).fetch = async (url: any, init: any) => {
  const body = JSON.parse(init.body);
  lastBody = body;
  if (mode === "legacy") {
    const rules = body.state.rules;
    delete body.state.rules;
    for (const [key, q] of Object.entries<any>(body.questions)) {
      const stem = key.replace(/_\d+$/, "");
      q.instructions = LEGACY_INSTR[stem](rules);
    }
    init.body = JSON.stringify(body);
  }
  return realFetch(url, init);
};

const rpcUrl = process.env.RPC_URL!;
const publicClient = createPublicClient({
  chain: base,
  transport: fallback([http(rpcUrl), http("https://base-rpc.publicnode.com")]),
}) as any;

const candidates = await scanAll(publicClient, await fetchEthPrice(publicClient));
// A spread of the book: the profit-sorted head, the middle, and the tail.
const sample = [0, 1, 2, 3, 4].flatMap((i) => {
  const idx = Math.floor((i * candidates.length) / 5);
  return candidates.slice(idx, idx + 2);
});
console.log(`\nA/B sample: ${sample.length} of ${candidates.length} candidates`);
for (const c of sample) {
  console.log(`  ${c.protocol} ${c.borrower.slice(0, 8)} watch=${c.watch} seize=$${c.expectedSeizeUsd.toFixed(0)} src=${c.priceSource}`);
}

const jev = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY!, model: process.env.JEV_MODEL ?? "jev-latest", baseUrl: "https://api.typesafe.ai" });

mode = "legacy";
const legacy = await jev.evaluateBatch(sample);
const legacyBytes = JSON.stringify(lastBody).length;
mode = "new";
const fresh = await jev.evaluateBatch(sample);
const newBytes = JSON.stringify(lastBody).length;

console.log(`\npayload: legacy ${(legacyBytes / 1024).toFixed(1)}KB -> new ${(newBytes / 1024).toFixed(1)}KB (${(100 - (newBytes / legacyBytes) * 100).toFixed(0)}% smaller)`);
console.log(`\n${"borrower".padEnd(12)} ${"legacy".padEnd(34)} ${"new".padEnd(34)} match`);
let agree = 0;
sample.forEach((c, i) => {
  const fmt = (d: any) => `${d.action} p=${d.actionProbabilities.EXECUTE?.toFixed(2)} ${d.reasoningCode}/pri${d.priority}/${d.sanity}`;
  const same = legacy[i].action === fresh[i].action && legacy[i].reasoningCode === fresh[i].reasoningCode;
  if (same) agree++;
  console.log(`${c.borrower.slice(0, 10).padEnd(12)} ${fmt(legacy[i]).padEnd(34)} ${fmt(fresh[i]).padEnd(34)} ${same ? "yes" : "NO"}`);
});
console.log(`\nagreement: ${agree}/${sample.length}`);
