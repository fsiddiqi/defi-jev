import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { base } from "viem/chains";
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

// ── Config ───────────────────────────────────────────────────────────────────

const MORPHO_BLUE_ADDRESS = (process.env.MORPHO_BLUE_ADDRESS ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb") as `0x${string}`;
const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
const WETH_ADDRESS = (process.env.WETH_ADDRESS ?? "0x4200000000000000000000000000000000000006") as `0x${string}`;

const ORACLE_PRICE_ABI = parseAbi(["function price() view returns (uint256)"]);

// ── Pagination + oracle price fallback ───────────────────────────────────────

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// The at-risk band is much wider than the liquidatable set (every position
// between HF 0.98 and 1.30); paginate deeper so we don't silently miss
// watch positions past the first 1000 results.
const WATCH_MAX_PAGES = Number(process.env.WATCH_MAX_PAGES ?? "30");
const ORACLE_TTL_MS = Number(process.env.ORACLE_PRICE_TTL_SEC ?? "300") * 1000;

// Morpho oracle prices barely move; cache per oracle address to keep RPC usage low.
const oraclePriceCache = new Map<string, { price: bigint; at: number }>();

async function getOraclePrice(client: PublicClient, oracle: `0x${string}`): Promise<bigint | null> {
  const key = oracle.toLowerCase();
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

// ── Morpho GraphQL ───────────────────────────────────────────────────────────

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

// ── Scanners ─────────────────────────────────────────────────────────────────

export async function scanMorpho(
  client: PublicClient,
  ethPriceUsd: number,
  opts: { watch?: boolean } = {},
): Promise<LiquidationCandidate[]> {
  const watch = opts.watch ?? false;
  // Morpho official GraphQL API - no API key required
  const query = `
    query($first:Int!,$skip:Int!,$where:MarketPositionFilters) {
      marketPositions(first:$first,skip:$skip,where:$where) {
        items {
          id
          healthFactor
          market {
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

  // Gas price is the same for every candidate — fetch once per scan.
  let gasPriceGwei = 0;
  try {
    gasPriceGwei = Number((await client.getGasPrice()) / 1_000_000_000n);
  } catch {
    // keep 0; pre-Jev gate treats unknown gas as pass
  }

  for (let page = 0; page < (watch ? WATCH_MAX_PAGES : MAX_PAGES); page++) {
    let data: any;
    try {
      data = await gqlClient.request(query, {
        first: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        where: watch
          ? { healthFactor_gte: WATCH_HF_MIN, healthFactor_lte: WATCH_HF_MAX, chainId_in: [8453] }
          : { healthFactor_lte: 1.0, chainId_in: [8453] },
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
        oraclePrice = await getOraclePrice(client, market.oracle.address);
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
        ? await readOracleAgeSec(client, market.oracle.address)
        : null;
      const oracleFreshnessSec = oracleAgeSec ?? 5;

      // DEX exit venue — "no fictions, only facts": only collateral with an
      // actual on-chain pool gets a sale price. stable/bluechip/lrt trade in
      // deep real markets, so the oracle price IS the exit price; listed and
      // long-tail MUST have a found pool or their profit is $0 downstream.
      let dexPriceUsd: number | null = null;
      let exitLiquidityUsd: number | null = null;
      let saleVenue: string | null = null;
      let priceSource: "oracle" | "dex" | "none" = "oracle";
      if (collateralTier === "listed" || collateralTier === "long-tail") {
        const quoteUsdMap: Record<string, number> = {
          [USDC_ADDRESS.toLowerCase()]: 1,
          [WETH_ADDRESS.toLowerCase()]: ethPriceUsd,
        };
        const pool = collateralAddress
          ? await findDexPool(client, collateralAddress, collateralDecimals, collateralSymbol, quoteUsdMap)
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

      console.log(`[scan] Candidate: ${p.user.address} HF=${p.healthFactor} collateral=${collateralSymbol} loan=${market.loanAsset.symbol} borrow=$${borrowUsd.toFixed(2)} coll=$${collateralUsd.toFixed(2)}${oraclePriced ? " (oracle-priced)" : ""} price=${priceSource}${saleVenue ? ` @ ${saleVenue} depth=$${exitLiquidityUsd?.toFixed(0)}` : ""}${priceSource === "none" ? " (no exit venue)" : ""}`);

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

      candidates.push({
        protocol: "morpho-blue",
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

  console.log(`[scan] Morpho API returned ${totalItems} ${watch ? "at-risk (HF " + WATCH_HF_MIN + "–" + WATCH_HF_MAX + ")" : "liquidatable"} positions (${pages} page${pages === 1 ? "" : "s"}, ${candidates.length} pass seize >= $${MIN_SEIZE_USD})`);
  return candidates;
}

export async function scanAll(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  const [morpho, watch] = await Promise.all([
    scanMorpho(client, ethPriceUsd),
    scanMorpho(client, ethPriceUsd, { watch: true }),
  ]);
  // Honest projected profit first — the number Jev sees and the feed sorts by.
  return [...morpho, ...watch].sort((a, b) => projectedProfitUsd(b, ethPriceUsd) - projectedProfitUsd(a, ethPriceUsd));
}
