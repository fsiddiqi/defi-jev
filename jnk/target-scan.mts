// Find REAL live-liquidatable Morpho Blue targets on Base — on-chain truth only.
//
// The subgraph is used ONLY to enumerate (borrower, marketId) pairs with HF<1;
// every number that matters is read on-chain:
//   position()  → collateral, borrowShares          (3-field ABI!)
//   market(id)  → totalBorrowAssets/Shares → debt   (ceil, loan wei)
//   oracle.price() → collateral value in loan wei   (coll * price / 1e36)
// Single-hop exit routes are discovered across the 3 factories and quoted
// empirically via PoolQuoter (V3/slipstream) or local reserves math (Aero V2).
//
//   ./node_modules/.bin/tsx jnk/target-scan.mts [maxRows] [--json out.json]
import "dotenv/config";
import {
  createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult,
  zeroAddress, type Hex,
} from "viem";
import { base } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.QUOTE_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const args = process.argv.slice(2);
const MAX_ROWS = Number(args.find((a) => !a.startsWith("--")) ?? "12");
const MIN_SEIZE = (() => { const i = args.indexOf("--min-seize"); return i >= 0 ? Number(args[i + 1]) || 0 : 0; })(); // 0 = quote everything incl. dust
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

// ── constants ────────────────────────────────────────────────────────────────
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const UNIV3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
const SLIPSTREAM = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as const;
const AERO_V2 = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const SCRATCH = "0x1337133713371337133713371337133713371337" as const;

const MORPHO_ABI = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const FACTORY_ABIS = {
  v3: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
  cl: parseAbi(["function getPool(address,address,int24) view returns (address)"]),
  v2: parseAbi(["function getPool(address,address,bool) view returns (address)"]),
};
const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteBatch((address pool,bool zeroForOne,uint256 amountIn)[] quotes) returns (uint256[] consumed, uint256[] received)",
]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

// ── subgraph: candidate enumeration only ─────────────────────────────────────
interface Cand {
  borrower: string;
  marketId: string;
  hfIndexer: number;
  collSym: string;
  loanSym: string;
  loanUsd: number | null;
}

async function fetchCandidates(): Promise<Cand[]> {
  const q = `query($first:Int!) {
    marketPositions(first:$first, where:{chainId_in:8453, healthFactor_lte:0.999999}) {
      items {
        healthFactor
        market { marketId collateralAsset { symbol } loanAsset { symbol priceUsd } }
        user { address }
        state { borrowAssets }
      }
    }
  }`;
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: { first: 200 } }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors[0]));
  return (json.data.marketPositions.items as any[])
    .filter((i) => i.healthFactor != null && Number(i.healthFactor) < 1.0 && i.state && i.state.borrowAssets && i.state.borrowAssets !== "0")
    .map((i) => ({
      borrower: i.user.address,
      marketId: i.market.marketId,
      hfIndexer: Number(i.healthFactor),
      collSym: i.market.collateralAsset.symbol,
      loanSym: i.market.loanAsset.symbol,
      loanUsd: i.market.loanAsset.priceUsd == null ? null : Number(i.market.loanAsset.priceUsd),
    }));
}

// ── market data cache ────────────────────────────────────────────────────────
interface MarketData {
  loanToken: `0x${string}`;
  collToken: `0x${string}`;
  oracle: `0x${string}`;
  irm: `0x${string}`;
  lltv: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  price: bigint; // loan wei per 1e36 coll wei → collValue = coll * price / 1e36
  collDec: number;
  loanDec: number;
}
const marketCache = new Map<string, MarketData>();

async function loadMarket(marketId: string): Promise<MarketData> {
  const hit = marketCache.get(marketId);
  if (hit) return hit;
  const params = (await client.readContract({
    address: MORPHO, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [marketId as `0x${string}`],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];
  const m = (await client.readContract({
    address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [marketId as `0x${string}`],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const price = await client.readContract({ address: params[2], abi: ORACLE_ABI, functionName: "price" });
  const [collDec, loanDec] = await Promise.all([
    client.readContract({ address: params[1], abi: DECIMALS_ABI, functionName: "decimals" }),
    client.readContract({ address: params[0], abi: DECIMALS_ABI, functionName: "decimals" }),
  ]);
  const md: MarketData = {
    loanToken: params[0], collToken: params[1], oracle: params[2], irm: params[3], lltv: params[4],
    totalBorrowAssets: m[2], totalBorrowShares: m[3],
    price: price as bigint, collDec: Number(collDec), loanDec: Number(loanDec),
  };
  marketCache.set(marketId, md);
  return md;
}

// ── route discovery (single hop, 3 factories) ────────────────────────────────
export interface Route {
  kind: "v3" | "v2";
  pool: `0x${string}`;
  label: string;
  zeroForOne: boolean; // input is token0?
  stable?: boolean;
}
const routeCache = new Map<string, Route[]>();

async function findRoutes(coll: `0x${string}`, loan: `0x${string}`): Promise<Route[]> {
  const key = `${coll.toLowerCase()}:${loan.toLowerCase()}`;
  const hit = routeCache.get(key);
  if (hit) return hit;
  const collIs0 = coll.toLowerCase() < loan.toLowerCase();
  const tiers = [100, 500, 3000, 10000];
  const spacings = [1, 20, 50, 100, 200, 500, 1000];
  const hits = await Promise.all([
    ...tiers.map((t) => client.readContract({ address: UNIV3, abi: FACTORY_ABIS.v3, functionName: "getPool", args: [coll, loan, t] }).catch(() => zeroAddress)),
    ...spacings.map((s) => client.readContract({ address: SLIPSTREAM, abi: FACTORY_ABIS.cl, functionName: "getPool", args: [coll, loan, s] }).catch(() => zeroAddress)),
    client.readContract({ address: AERO_V2, abi: FACTORY_ABIS.v2, functionName: "getPool", args: [coll, loan, false] }).catch(() => zeroAddress),
    client.readContract({ address: AERO_V2, abi: FACTORY_ABIS.v2, functionName: "getPool", args: [coll, loan, true] }).catch(() => zeroAddress),
  ]);
  const routes: Route[] = [];
  let i = 0;
  for (const t of tiers) {
    const p = hits[i++] as `0x${string}`;
    if (p !== zeroAddress) routes.push({ kind: "v3", pool: p, label: `univ3 f${t}`, zeroForOne: collIs0 });
  }
  for (const s of spacings) {
    const p = hits[i++] as `0x${string}`;
    if (p !== zeroAddress) routes.push({ kind: "v3", pool: p, label: `slip ts${s}`, zeroForOne: collIs0 });
  }
  const vol = hits[i++] as `0x${string}`;
  const sta = hits[i++] as `0x${string}`;
  if (vol !== zeroAddress) routes.push({ kind: "v2", pool: vol, label: "aero-v2 volatile", zeroForOne: collIs0, stable: false });
  if (sta !== zeroAddress) routes.push({ kind: "v2", pool: sta, label: "aero-v2 stable", zeroForOne: collIs0, stable: true });
  routeCache.set(key, routes);
  return routes;
}

// ── proceeds quotes ──────────────────────────────────────────────────────────
const artifact = JSON.parse(readFileSync("contracts/out/PoolQuoter.json", "utf8")) as { deployedBytecode: Hex };

async function quoteV3(pool: `0x${string}`, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteBatch", args: [[{ pool, zeroForOne, amountIn }]] });
    const res = await client.call({ to: SCRATCH, data, stateOverride: [{ address: SCRATCH, code: artifact.deployedBytecode }] });
    if (!res.data) return null;
    const [, received] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteBatch", data: res.data });
    return received[0] as bigint;
  } catch { return null; }
}

async function quoteV2(pool: `0x${string}`, inIs0: boolean, amountIn: bigint, stable: boolean): Promise<bigint | null> {
  try {
    const reserves = await client.readContract({ address: pool, abi: PAIR_ABI, functionName: "getReserves" });
    const r0 = (reserves as readonly [bigint, bigint, bigint])[0];
    const r1 = (reserves as readonly [bigint, bigint, bigint])[1];
    const rIn = inIs0 ? r0 : r1;
    const rOut = inIs0 ? r1 : r0;
    if (rIn === 0n || rOut === 0n) return null;
    const feeBps = stable ? 5n : 30n;
    const amtInF = amountIn * (10_000n - feeBps);
    return (amtInF * rOut) / (rIn * 10_000n + amtInF);
  } catch { return null; }
}

// direction for a route: input token = collateral (already encoded in zeroForOne from findRoutes)

// Morpho incentive factor (same as bot)
const fFactor = (lltv: bigint) => {
  const l = Number(lltv) / 1e18;
  return Math.min(1.15, 1 / (1 - 0.3 * (1 - Math.min(Math.max(l, 0.001), 0.999))));
};

interface Target {
  borrower: string;
  marketId: string;
  collSym: string;
  loanSym: string;
  hf: number;
  seizeColl: bigint;
  repaidShares: bigint;
  repayLoan: bigint; // loan wei (ceil)
  bestLabel: string;
  bestPool: string;
  bestZf1: boolean;
  proceeds: bigint; // loan wei
  sizeFrac: number; // 1 = full position
  grossLoan: bigint;
  grossUsd: number | null;
}

async function main() {
  console.log(`target-scan v2: on-chain truth only (RPC ${RPC})`);
  const cands = await fetchCandidates();
  console.log(`subgraph: ${cands.length} rows HF<1 with nonzero borrow\n`);

  // pass 1: on-chain position + market math
  const real: Array<{ c: Cand; md: MarketData; collateral: bigint; borrowShares: bigint; debt: bigint; collValue: bigint }> = [];
  let empty = 0, err = 0;
  for (const c of cands) {
    try {
      const [md, pos] = await Promise.all([
        loadMarket(c.marketId),
        client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [c.marketId as `0x${string}`, c.borrower as `0x${string}`] }),
      ]);
      const p = pos as readonly [bigint, bigint, bigint];
      const collateral = p[2], borrowShares = p[1];
      if (collateral === 0n || borrowShares === 0n) { empty++; continue; }
      if (md.totalBorrowShares === 0n) { empty++; continue; }
      const debt = (borrowShares * md.totalBorrowAssets + md.totalBorrowShares - 1n) / md.totalBorrowShares; // ceil
      const collValue = (collateral * md.price) / 10n ** 36n;
      if (debt === 0n || collValue === 0n) { empty++; continue; }
      real.push({ c, md, collateral, borrowShares, debt, collValue });
    } catch (e) {
      err++;
      if (err <= 2) console.log(`  err ${c.marketId.slice(0, 10)} ${c.borrower.slice(0, 10)}: ${String((e as any)?.shortMessage ?? e).slice(0, 120)}`);
    }
  }
  console.log(`on-chain: ${real.length} positions with collateral>0, ${empty} empty, ${err} errors\n`);

  // pass 2: on-chain HF filter + seize/repay math + quote exits
  const targets: Target[] = [];
  let healthy = 0, dust = 0, noRoute = 0, noQuote = 0;
  const nearMiss = new Map<string, { ratio: number; hf: number; borrower: string; seizeUsd: number | null }>();
  interface Row { pair: string; hf: number; seizeUsd: number | null; seizeLoan: bigint; status: string; borrower: string }
  const report: Row[] = [];
  for (const { c, md, collateral, borrowShares, debt, collValue } of real) {
    const hf = (Number((collValue * md.lltv) / debt)) / 1e18;
    if (hf >= 1.0) { healthy++; continue; }

    const ff = fFactor(md.lltv);
    const fWad = BigInt(Math.round(ff * 1e18));
    // seize = min(collValue, debt*f) ; repay = min(debt, collValue/f)   [loan wei]
    const debtF = (debt * fWad) / 10n ** 18n;
    const seizeLoan = collValue < debtF ? collValue : debtF;
    const repayLoan = collValue < debtF ? (collValue * 10n ** 18n) / fWad : debt;
    if (seizeLoan === 0n) { dust++; continue; }
    // collateral to seize (coll wei): proportional when capped by debt*f
    const seizeColl = collValue < debtF ? collateral : (collateral * debtF) / collValue;
    if (seizeColl === 0n) { dust++; continue; }

    const usd = (loanWei: bigint) => c.loanUsd != null ? (Number(loanWei) / 10 ** md.loanDec) * c.loanUsd : null;
    const seizeUsd = usd(seizeLoan) ?? 0;
    const pair = `${c.collSym}/${c.loanSym}`;
    if (seizeUsd > 0 && seizeUsd < MIN_SEIZE) {
      dust++;
      report.push({ pair, hf, seizeUsd: usd(seizeLoan), seizeLoan, status: `dust<$${MIN_SEIZE}`, borrower: c.borrower });
      continue;
    }

    const routes = await findRoutes(md.collToken, md.loanToken);
    if (!routes.length) {
      noRoute++;
      report.push({ pair, hf, seizeUsd: usd(seizeLoan), seizeLoan, status: "NO ROUTE", borrower: c.borrower });
      continue;
    }

    // ladder: full first, then smaller fractions (better price impact ratio)
    const fracs = [1, 0.5, 0.25, 0.1, 0.05];
    let best: Target | null = null;
    let bestRatio = 0;
    for (const fr of fracs) {
      const amtIn = (seizeColl * BigInt(Math.round(fr * 1e6))) / 1000000n;
      const shares = (borrowShares * BigInt(Math.round(fr * 1e6))) / 1000000n;
      const repay = (repayLoan * BigInt(Math.round(fr * 1e6))) / 1000000n;
      if (amtIn === 0n || shares === 0n || repay === 0n) continue;
      for (const rt of routes) {
        const got = rt.kind === "v3"
          ? await quoteV3(rt.pool, rt.zeroForOne, amtIn)
          : await quoteV2(rt.pool, rt.zeroForOne, amtIn, rt.stable ?? false);
        if (got == null || got === 0n) continue;
        const ratio = Number((got * 10000n) / repay) / 10000;
        if (ratio > bestRatio) bestRatio = ratio;
        if (got >= repay && (!best || got - repay > best.grossLoan)) {
          best = {
            borrower: c.borrower, marketId: c.marketId, collSym: c.collSym, loanSym: c.loanSym,
            hf, seizeColl: amtIn, repaidShares: shares, repayLoan: repay,
            bestLabel: rt.label, bestPool: rt.pool, bestZf1: rt.zeroForOne, proceeds: got, sizeFrac: fr,
            grossLoan: got - repay, grossUsd: usd(got - repay),
          };
        }
        // track near-misses (ratio) for reporting even when unprofitable
        const key = `${c.collSym}/${c.loanSym} via ${rt.label}`;
        const prev = nearMiss.get(key);
        if (!prev || ratio > prev.ratio) nearMiss.set(key, { ratio, hf, borrower: c.borrower, seizeUsd: usd(seizeLoan) });
      }
    }
    if (!best) {
      noQuote++;
      report.push({ pair, hf, seizeUsd: usd(seizeLoan), seizeLoan, status: `proceeds ${(bestRatio * 100).toFixed(0)}% of repay`, borrower: c.borrower });
      continue;
    }
    report.push({ pair, hf, seizeUsd: usd(seizeLoan), seizeLoan, status: `EXEC ${best.bestLabel} gross=${best.grossUsd != null ? "$" + best.grossUsd.toFixed(2) : best.grossLoan.toString()}`, borrower: c.borrower });
    targets.push(best);
  }

  targets.sort((a, b) => (b.grossUsd ?? 0) - (a.grossUsd ?? 0));
  console.log(`EXEC-able: ${targets.length}   (healthy=${healthy} dust/sub-$50=${dust} noRoute=${noRoute} proceeds<repay=${noQuote})\n`);
  report.sort((a, b) => (b.seizeUsd ?? 0) - (a.seizeUsd ?? 0));
  console.log(`top underwater rows by seize size (all 3 gates shown):`);
  for (const r of report.slice(0, 20)) {
    console.log(`  $${(r.seizeUsd ?? 0).toFixed(0).padStart(9)}  hf=${r.hf.toFixed(3)}  ${r.pair.padEnd(18)} ${r.status}`);
  }
  const noRouteRows = report.filter((r) => r.status === "NO ROUTE").sort((a, b) => (b.seizeUsd ?? 0) - (a.seizeUsd ?? 0));
  if (noRouteRows.length) {
    console.log(`\nno-direct-route rows (2-hop candidates):`);
    for (const r of noRouteRows.slice(0, 15)) {
      console.log(`  $${(r.seizeUsd ?? 0).toFixed(0).padStart(9)}  hf=${r.hf.toFixed(3)}  ${r.pair.padEnd(18)} ${r.borrower}`);
    }
  }
  console.log("");
  if (nearMiss.size) {
    console.log(`closest exits (proceeds/repay ratio, 1.00 = break-even):`);
    for (const [k, v] of [...nearMiss].sort((a, b) => b[1].ratio - a[1].ratio).slice(0, 12)) {
      console.log(`  ${(v.ratio * 100).toFixed(1)}%  ${k}  hf=${v.hf.toFixed(3)} seize=$${v.seizeUsd?.toFixed(0) ?? "?"}`);
    }
    console.log("");
  }
  const top = targets.slice(0, MAX_ROWS);
  for (const t of top) {
    const g = t.grossUsd != null ? `$${t.grossUsd.toFixed(2)}` : `${t.grossLoan} ${t.loanSym}`;
    console.log(
      `EXEC ${t.borrower} ${t.collSym}/${t.loanSym} hf=${t.hf.toFixed(4)} size=${(t.sizeFrac * 100).toFixed(0)}% ` +
      `seize=${t.seizeColl} repay=${t.repayLoan} proceeds=${t.proceeds} gross=${g} via ${t.bestLabel} pool=${t.bestPool.slice(0, 10)}…`,
    );
  }
  if (jsonOut && top.length) {
    writeFileSync(jsonOut, JSON.stringify(top, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(`\nwrote ${top.length} targets → ${jsonOut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
