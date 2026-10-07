import { createPublicClient, fallback, http, parseAbi, type PublicClient } from "viem";
import { gql, GraphQLClient } from "graphql-request";
import type { LiquidationCandidate, AssetTier } from "./types.js";
import {
  estimateGas,
  resolveCollateralUsd,
} from "./lib/scanMath.js";
import { findDexPool, readOracleAgeSec } from "./lib/prices.js";
import {
  morphoEdgeOfSeize,
  morphoSeizedUsd,
  projectedProfitUsd,
} from "./profit.js";
import { CHAINS, SCANNED_CHAIN_IDS } from "./lib/chains.js";

// ── Config ───────────────────────────────────────────────────────────────────

const ORACLE_PRICE_ABI = parseAbi(["function price() view returns (uint256)"]);

// ── Pagination + oracle price fallback ───────────────────────────────────────

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// The at-risk band is much wider than the liquidatable set (every position
// between HF 0.98 and 1.30); paginate deeper so we don't silently miss
// watch positions past the first 1000 results.
const WATCH_MAX_PAGES = Number(process.env.WATCH_MAX_PAGES ?? "30");
const ORACLE_TTL_MS = Number(process.env.ORACLE_PRICE_TTL_SEC ?? "300") * 1000;

// Morpho oracle prices barely move; cache per (chain, oracle) to keep RPC
// usage low. The same oracle address can exist on several chains.
const oraclePriceCache = new Map<string, { price: bigint; at: number }>();

async function getOraclePrice(client: PublicClient, chainId: number, oracle: `0x${string}`): Promise<bigint | null> {
  const key = `${chainId}:${oracle.toLowerCase()}`;
  const hit = oraclePriceCache.get(key);
  if (hit && Date.now() - hit.at < ORACLE_TTL_MS) return hit.price;
  try {
    const price = await client.readContract({
      address: oracle,
      abi: ORACLE_PRICE_ABI,
      functionName: "price",
    });
    oraclePriceCache.set(key, { price, at: Date.now() });
    return price;
  } catch {
    return null; // rate limit / stale cache miss — skip this cycle
  }
}

// ── Morpho GraphQL (multi-chain) ─────────────────────────────────────────────

const MIN_SEIZE_USD = Number(process.env.MIN_SEIZE_USD ?? "500");

// At-risk watchlist — positions above the liquidation line but close enough to
// be worth a pre-computed Jev verdict for the moment they cross. The band is
// strictly (1.0, WATCH_HF_MAX]; the liquidatable scan already owns HF < 1.0.
const WATCH_HF_MIN = Number(process.env.WATCH_HF_MIN ?? "0.98");
const WATCH_HF_MAX = Number(process.env.WATCH_HF_MAX ?? "1.30");
// Only watch positions whose borrow is big enough to matter — at-risk dust
// (small unstaked positions) is noise, not pipeline. Default $1K.
const WATCH_MIN_BORROW_USD = Number(process.env.WATCH_MIN_BORROW_USD ?? "1000");
// Collateral families with no real exit market (Resolv post-exploit ghost
// tokens: USR, RSS, RLP, wbCOIN, WXRWA1, …) are already honestly blocked in
// the liquidatable feed; keep them out of the at-risk panel so it shows real
// collateral only. Override to "" to include everything.
const WATCH_COLLATERAL_DENYLIST = new Set(
  (process.env.WATCH_COLLATERAL_DENYLIST ?? "USR,RSS,RLP,wbCOIN,WXRWA1,stUSR,USDF,REIT,UBTC")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const gqlClient = new GraphQLClient("https://api.morpho.org/graphql");

function getAssetTier(symbol: string): AssetTier {
  const s = symbol.toLowerCase();
  if (["usdc", "usdt", "dai", "eurc", "usde"].includes(s)) return "stable";
  if (["weth", "eth", "cbeth", "reth", "wsteth", "steth"].includes(s)) return "bluechip";
  if (["ezeth", "rseth", "weeth", "puffeth"].includes(s)) return "lrt";
  // Listed = a real, verified sales venue exists: USR redeems 1:1 via Mountain
  // (Mountain Protocol) and trades on Aerodrome; wbCOIN is wrapped Bitcoin with
  // DEX markets. Thin liquidity — never EXECUTE-grade without checking size.
  if (["usr", "wbcoin"].includes(s)) return "listed";
  return "long-tail";
}

/** Read clients per chain from the registry (reads need no chain object). */
export function buildChainClients(): Map<number, PublicClient> {
  const clients = new Map<number, PublicClient>();
  for (const meta of SCANNED_CHAIN_IDS.map((id) => CHAINS[id])) {
    clients.set(meta.id, createPublicClient({ transport: fallback(meta.rpc.map((u) => http(u))) }));
  }
  return clients;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

export async function scanMorpho(
  clients: Map<number, PublicClient>,
  ethPriceUsd: number,
  opts: { watch?: boolean } = {},
): Promise<LiquidationCandidate[]> {
  const watch = opts.watch ?? false;
  // Morpho official GraphQL API - no API key required. One query spans every
  // scanned chain via chainId_in; the per-item chain id drives all on-chain
  // reads (each against that chain's own RPC).
  const query = `
    query($first:Int!,$skip:Int!,$where:MarketPositionFilters) {
      marketPositions(first:$first,skip:$skip,where:$where) {
        items {
          id
          healthFactor
          market {
            chain { id }
            marketId
            lltv
            oracle { address }
            loanAsset { symbol decimals priceUsd }
            collateralAsset { symbol decimals address priceUsd }
          }
          user { address }
          state { borrowAssets borrowAssetsUsd collateral collateralUsd }
        }
      }
    }
  `;

  const candidates: LiquidationCandidate[] = [];
  let totalItems = 0;
  let pages = 0;
  const gasByChain = new Map<number, number>();

  for (let page = 0; page < (watch ? WATCH_MAX_PAGES : MAX_PAGES); page++) {
    let data: any;
    try {
      data = await gqlClient.request(query, {
        first: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        where: watch
          ? { healthFactor_gte: WATCH_HF_MIN, healthFactor_lte: WATCH_HF_MAX, chainId_in: SCANNED_CHAIN_IDS }
          : { healthFactor_lte: 1.0, chainId_in: SCANNED_CHAIN_IDS },
      });
    } catch {
      break; // API hiccup — keep what we have
    }

    const items = data?.marketPositions?.items ?? [];
    pages++;
    totalItems += items.length;

    for (const p of items) {
      // Liquidatable scan owns HF < 1.0; the watch scan owns HF in (1.0, max].
      if (p.healthFactor === null) continue;
      if (watch ? p.healthFactor <= 1.0 : p.healthFactor >= 1.0) {
        continue;
      }

      const chainId = Number(p.market?.chain?.id ?? 0);
      const meta = CHAINS[chainId];
      const client = clients.get(chainId);
      if (!meta || !client) {
        console.warn(`[scan] skipping position on unknown chain ${chainId} (${p.user.address})`);
        totalItems--;
        continue;
      }

      const market = p.market;
      const state = p.state;

      let collateralUsd = Number(state.collateralUsd ?? 0);
      const borrowUsd = Number(state.borrowAssetsUsd ?? 0);
      const lltv = Number(market.lltv ?? 0) / 1e18 || 1.0;

      // The indexer USD fields are corrupt for some markets (e.g. USR priced
      // ~12x low) while the health factor - computed from the on-chain oracle -
      // is consistent with real prices. Every market has its on-chain oracle:
      // re-price from it when the indexer field is missing OR inconsistent with
      // the reported HF (same mismatch metric dataIntegrityGate uses). This is
      // what turns the USR positions into discoverable candidates instead of
      // false data-integrity blocks.
      const maxHfMismatch = Number(process.env.MAX_HF_MISMATCH_PCT ?? "0.30");
      const hfFromIndexerUsd = borrowUsd > 0 && collateralUsd > 0 ? (lltv * collateralUsd) / borrowUsd : null;
      const needOracle =
        collateralUsd === 0 ||
        (hfFromIndexerUsd !== null && p.healthFactor > 0 && Math.abs(hfFromIndexerUsd - p.healthFactor) / p.healthFactor > maxHfMismatch);
      let oraclePrice: bigint | null = null;
      if (needOracle && market.oracle?.address) {
        oraclePrice = await getOraclePrice(client, chainId, market.oracle.address);
      }
      const resolved = resolveCollateralUsd({
        indexerUsd: collateralUsd,
        oraclePrice,
        state,
        collateralDecimals: Number(market.collateralAsset.decimals ?? 18),
        borrowUsd,
        healthFactor: p.healthFactor,
        liquidationThreshold: lltv,
        maxMismatchPct: maxHfMismatch,
      });
      collateralUsd = resolved.collateralUsd;
      const oraclePriced = resolved.oraclePriced;

      const collateralDecimals = Number(market.collateralAsset.decimals ?? 18);
      const collateralAddress = (market.collateralAsset.address ?? "") as `0x${string}`;
      const collateralSymbol = market.collateralAsset.symbol;
      const collateralTier = getAssetTier(collateralSymbol);

      // Keep no-exit ghost collateral (Resolv family) out of the at-risk panel —
      // it is already honestly blocked in the liquidatable feed. And skip
      // at-risk dust: only positions whose borrow is big enough to matter.
      if (watch && WATCH_COLLATERAL_DENYLIST.has(collateralSymbol.toLowerCase())) {
        continue;
      }
      if (watch && borrowUsd < WATCH_MIN_BORROW_USD) {
        continue;
      }

      // USD per collateral unit at the on-chain oracle — what the protocol
      // actually prices liquidations off. Derived from the reprice above
      // (oracle USD / raw units), no extra RPC.
      const rawUnits = Number(state.collateral ?? 0);
      const oraclePriceUsd = rawUnits > 0 ? collateralUsd / (rawUnits / 10 ** collateralDecimals) : null;

      // True oracle age from the feed itself (Chainlink latestRoundData or
      // MMA updatedAt); falls back to the old default when unknowable.
      const oracleAgeSec = market.oracle?.address
        ? await readOracleAgeSec(client, chainId, market.oracle.address)
        : null;
      const oracleFreshnessSec = oracleAgeSec ?? 5;

      // DEX exit venue — "no fictions, only facts": only collateral with an
      // actual on-chain pool gets a sale price. stable/bluechip/lrt trade in
      // deep real markets, so the oracle price IS the exit price; listed and
      // long-tail MUST have a found pool or their profit is $0 downstream. A
      // chain without verified factory/quote-token addresses reports "none".
      let dexPriceUsd: number | null = null;
      let exitLiquidityUsd: number | null = null;
      let saleVenue: string | null = null;
      let priceSource: "oracle" | "dex" | "none" = "oracle";
      if (collateralTier === "listed" || collateralTier === "long-tail") {
        const quoteUsdMap: Record<string, number> = {};
        if (meta.usdc) quoteUsdMap[meta.usdc.toLowerCase()] = 1;
        if (meta.weth) quoteUsdMap[meta.weth.toLowerCase()] = ethPriceUsd;
        const pool = collateralAddress
          ? await findDexPool(client, collateralAddress, collateralDecimals, collateralSymbol, quoteUsdMap, chainId)
          : null;
        if (pool) {
          dexPriceUsd = pool.dexPriceUsd;
          exitLiquidityUsd = pool.exitLiquidityUsd;
          saleVenue = pool.venue;
          priceSource = "dex";
        } else {
          priceSource = "none";
        }
      }

      console.log(`[scan] [${meta.name}] Candidate: ${p.user.address} HF=${p.healthFactor} collateral=${collateralSymbol} loan=${market.loanAsset.symbol} borrow=$${borrowUsd.toFixed(2)} coll=$${collateralUsd.toFixed(2)}${oraclePriced ? " (oracle-priced)" : ""} price=${priceSource}${saleVenue ? ` @ ${saleVenue} depth=$${exitLiquidityUsd?.toFixed(0)}` : ""}${priceSource === "none" ? " (no exit venue)" : ""}`);

      if (collateralUsd === 0 || borrowUsd === 0) {
        console.log(`[scan] Skipping ${p.user.address}: zero USD values (collateral=${collateralUsd} borrow=${borrowUsd})`);
        continue;
      }

      const seizePct = morphoEdgeOfSeize(lltv);
      // Morpho has no close factor: the whole position can be liquidated at
      // once, seizing min(collateral, borrow * incentiveFactor) and keeping
      // edge = seized * (1 - 1/f) on it. Gross seized value (not profit):
      const expectedSeize = morphoSeizedUsd(borrowUsd, collateralUsd, lltv);

      if (expectedSeize < MIN_SEIZE_USD) {
        console.log(`[scan] Skipping ${p.user.address}: seized $${expectedSeize.toFixed(2)} < ${MIN_SEIZE_USD}`);
        continue;
      }

      // Real per-chain gas price (one read per chain per scan; 0 when the RPC
      // refuses — the pre-Jev gate treats unknown gas as pass).
      let gasPriceGwei = gasByChain.get(chainId) ?? 0;
      if (gasPriceGwei === 0 && !gasByChain.has(chainId)) {
        try {
          gasPriceGwei = Number((await client.getGasPrice()) / 1_000_000_000n);
        } catch {
          gasPriceGwei = 0;
        }
        gasByChain.set(chainId, gasPriceGwei);
      }

      candidates.push({
        protocol: "morpho-blue",
        chainId,
        marketId: (market.marketId ?? null) as `0x${string}` | null,
        borrower: p.user.address as `0x${string}`,
        collateralAsset: collateralSymbol,
        collateralTier,
        borrowAsset: market.loanAsset.symbol,
        currentLtv: collateralUsd > 0 ? borrowUsd / collateralUsd : 0,
        liquidationThreshold: lltv,
        healthFactor: p.healthFactor,
        collateralBalanceUsd: collateralUsd,
        borrowBalanceUsd: borrowUsd,
        seizePct,
        expectedSeizeUsd: expectedSeize,
        oracleFreshnessSec,
        gasPriceGwei,
        estimatedExecutionGas: estimateGas(),
        recentPriceMovePct30m: 0,
        cascadeScore: 0,
        competitionLast10Blocks: 0,
        ageBlocks: 999,
        oraclePriceUsd,
        oracleAgeSec,
        dexPriceUsd,
        exitLiquidityUsd,
        priceSource,
        saleVenue,
        watch,
      });
    }

    if (items.length < PAGE_SIZE) break;
  }

  console.log(`[scan] Morpho API returned ${totalItems} ${watch ? "at-risk (HF " + WATCH_HF_MIN + "–" + WATCH_HF_MAX + ")" : "liquidatable"} positions across ${SCANNED_CHAIN_IDS.length} chains (${pages} page${pages === 1 ? "" : "s"}, ${candidates.length} pass seize >= $${MIN_SEIZE_USD})`);
  return candidates;
}

export async function scanAll(clients: Map<number, PublicClient>, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  const [morpho, watch] = await Promise.all([
    scanMorpho(clients, ethPriceUsd),
    scanMorpho(clients, ethPriceUsd, { watch: true }),
  ]);
  // Honest projected profit first — the number Jev sees and the feed sorts by.
  return [...morpho, ...watch].sort((a, b) => projectedProfitUsd(b, ethPriceUsd) - projectedProfitUsd(a, ethPriceUsd));
}