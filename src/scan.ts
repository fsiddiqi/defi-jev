import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { base } from "viem/chains";
import { gql, GraphQLClient } from "graphql-request";
import type { LiquidationCandidate, Protocol, AssetTier } from "./types.js";
import {
  estimateGas,
  resolveCollateralUsd,
} from "./lib/scanMath.js";
import {
  IONIC_INCENTIVE,
  ionicSeizedUsd,
  morphoEdgeOfSeize,
  morphoSeizedUsd,
  projectedProfitUsd,
} from "./profit.js";

// ── Config ───────────────────────────────────────────────────────────────────

const MORPHO_BLUE_ADDRESS = (process.env.MORPHO_BLUE_ADDRESS ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb") as `0x${string}`;
const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
const WETH_ADDRESS = (process.env.WETH_ADDRESS ?? "0x4200000000000000000000000000000000000006") as `0x${string}`;

const CHRONIC_IONIC_BORROWERS = [
  "0x4f6a86e349e4203262c53d8dcdb1b746c63e346f",
  "0x0b5897d201d83a9fcbeefc086c100a8eaa5ada9a",
  "0x06bbdce39a531dfe8cf99916d4a4c21c22ca0f0c",
  "0x166b9a0390474c455115dfb64579d1d79286588f",
  "0x31a756d617a498767574a5342921c36cc4352096",
  "0x1eb322c016815ee5b29c071586c1b75be5934576",
] as const;

const IONIC_COMPTROLLER_ABI = parseAbi([
  "function getAccountSnapshot(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)",
  "function getAllMarkets() view returns (address[])",
]);

const ORACLE_PRICE_ABI = parseAbi(["function price() view returns (uint256)"]);

// ── Pagination + oracle price fallback ───────────────────────────────────────

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
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

export async function scanMorpho(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
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
            collateralAsset { symbol decimals priceUsd }
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

  for (let page = 0; page < MAX_PAGES; page++) {
    let data: any;
    try {
      data = await gqlClient.request(query, {
        first: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        where: { healthFactor_lte: 1.0, chainId_in: [8453] },
      });
    } catch {
      break; // API hiccup — keep what we have
    }

    const items = data?.marketPositions?.items ?? [];
    pages++;
    totalItems += items.length;

    for (const p of items) {
      if (p.healthFactor === null || p.healthFactor >= 1.0) {
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

      console.log(`[scan] Candidate: ${p.user.address} HF=${p.healthFactor} collateral=${market.collateralAsset.symbol} loan=${market.loanAsset.symbol} borrow=$${borrowUsd.toFixed(2)} coll=$${collateralUsd.toFixed(2)}${oraclePriced ? " (oracle-priced)" : ""}`);

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
        collateralAsset: market.collateralAsset.symbol,
        collateralTier: getAssetTier(market.collateralAsset.symbol),
        borrowAsset: market.loanAsset.symbol,
        currentLtv: collateralUsd > 0 ? borrowUsd / collateralUsd : 0,
        liquidationThreshold: lltv,
        healthFactor: p.healthFactor,
        collateralBalanceUsd: collateralUsd,
        borrowBalanceUsd: borrowUsd,
        seizePct,
        expectedSeizeUsd: expectedSeize,
        oracleFreshnessSec: 5,
        gasPriceGwei,
        estimatedExecutionGas: estimateGas("morpho-blue"),
        recentPriceMovePct30m: 0,
        cascadeScore: 0,
        competitionLast10Blocks: 0,
        ageBlocks: 999,
      });
    }

    if (items.length < PAGE_SIZE) break;
  }

  console.log(`[scan] Morpho API returned ${totalItems} liquidatable positions (${pages} page${pages === 1 ? "" : "s"}, ${candidates.length} pass seize >= $${MIN_SEIZE_USD})`);
  return candidates;
}

export async function scanIonicChronic(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  const candidates: LiquidationCandidate[] = [];

  let gasPriceGwei = 0;
  try {
    gasPriceGwei = Number((await client.getGasPrice()) / 1_000_000_000n);
  } catch {
    // unknown gas — treat as 0
  }

  for (const borrower of CHRONIC_IONIC_BORROWERS) {
    try {
      const snapshot = await client.readContract({
        address: MORPHO_BLUE_ADDRESS, // Using Morpho Blue address as Ionic comptroller placeholder
        abi: IONIC_COMPTROLLER_ABI,
        functionName: "getAccountSnapshot",
        args: [borrower as `0x${string}`],
      }) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

      // Snapshot returns: error, collateralUsd, borrowUsd, ...
      // This is a simplification - actual Ionic scanner uses cToken markets
      const collateralUsd = Number(snapshot[1]) / 1e18 * ethPriceUsd;
      const borrowUsd = Number(snapshot[2]) / 1e18 * ethPriceUsd;

      if (borrowUsd === 0) continue;

      const ltv = borrowUsd / collateralUsd;
      if (ltv < 0.8) continue;

      const seizePct = IONIC_INCENTIVE / (1 + IONIC_INCENTIVE);
      // Ionic is compound-v2 style: repay <= closeFactor * borrow, receive
      // collateral worth repay * (1 + bonus), capped by posted collateral.
      const expectedSeize = ionicSeizedUsd(borrowUsd, collateralUsd);

      if (expectedSeize < MIN_SEIZE_USD) {
        console.log(`[scan] Skipping ${borrower}: seized $${expectedSeize.toFixed(2)} < ${MIN_SEIZE_USD}`);
        continue;
      }

      candidates.push({
        protocol: "ionic",
        borrower: borrower as `0x${string}`,
        collateralAsset: "IONIC_COLLATERAL", // placeholder - needs real token resolution
        collateralTier: getAssetTier("IONIC_COLLATERAL"),
        borrowAsset: "IONIC_DEBT",
        currentLtv: ltv,
        liquidationThreshold: 0.9,
        healthFactor: 0.9 / ltv,
        collateralBalanceUsd: collateralUsd,
        borrowBalanceUsd: borrowUsd,
        seizePct,
        expectedSeizeUsd: expectedSeize,
        oracleFreshnessSec: 300, // Ionic is slower
        gasPriceGwei,
        estimatedExecutionGas: estimateGas("ionic"),
        recentPriceMovePct30m: 0,
        cascadeScore: 0,
        competitionLast10Blocks: 0,
        ageBlocks: 999,
      });
    } catch {
      // Skip on error
    }
  }

  return candidates;
}

export async function scanAll(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  const [morpho, ionic] = await Promise.all([
    scanMorpho(client, ethPriceUsd),
    scanIonicChronic(client, ethPriceUsd),
  ]);
  // Honest projected profit first — the number Jev sees and the feed sorts by.
  return [...morpho, ...ionic].sort((a, b) => projectedProfitUsd(b) - projectedProfitUsd(a));
}
