import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { base } from "viem/chains";
import { gql, GraphQLClient } from "graphql-request";
import type { LiquidationCandidate, Protocol, AssetTier } from "./types.js";

// ── Config ───────────────────────────────────────────────────────────────────

const MORPHO_SUBGRAPH = process.env.MORPHO_SUBGRAPH ?? "";
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

// ── Morpho GraphQL ───────────────────────────────────────────────────────────

const MORPHO_POSITIONS_QUERY = gql`
  query Positions($first: Int!, $skip: Int!, $ltvMin: Float!) {
    positions(first: $first, skip: $skip, where: { ltv_gt: $ltvMin, market: { chainId_in: [8453] } }) {
      id
      borrower
      collateral { symbol address priceUsd }
      borrow { symbol address priceUsd }
      collateralBalance
      borrowBalance
      ltv
      liquidationLtv
      market { lltv }
    }
  }
`;

function getAssetTier(symbol: string): AssetTier {
  const s = symbol.toLowerCase();
  if (["usdc", "usdt", "dai", "eurc", "usde"].includes(s)) return "stable";
  if (["weth", "eth", "cbeth", "reth", "wsteth", "steth"].includes(s)) return "bluechip";
  if (["ezeth", "rseth", "weeth", "puffeth"].includes(s)) return "lrt";
  return "long-tail";
}

function estimateSeizePct(protocol: Protocol): number {
  return protocol === "ionic" ? 0.05 : 0.08; // Morpho ~8%, Ionic ~5%
}

function estimateGas(protocol: Protocol): number {
  return protocol === "ionic" ? 750_000 : 900_000;
}

// ── Scanners ─────────────────────────────────────────────────────────────────

export async function scanMorpho(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  if (!MORPHO_SUBGRAPH) return [];

  const graphql = new GraphQLClient(MORPHO_SUBGRAPH);
  const vars = { first: 100, skip: 0, ltvMin: 0.8 };
  let data: any;

  try {
    data = await graphql.request(MORPHO_POSITIONS_QUERY, vars);
  } catch {
    return [];
  }

  const positions = data?.positions ?? [];
  const candidates: LiquidationCandidate[] = [];

  for (const p of positions) {
    const collateralUsd = Number(p.collateralBalance) * Number(p.collateral.priceUsd);
    const borrowUsd = Number(p.borrowBalance) * Number(p.borrow.priceUsd);
    const seizePct = estimateSeizePct("morpho-blue");
    const expectedSeizeUsd = borrowUsd * seizePct;

    if (expectedSeizeUsd < 500) continue; // pre-filter

    candidates.push({
      protocol: "morpho-blue",
      borrower: p.borrower as `0x${string}`,
      collateralAsset: p.collateral.symbol,
      borrowAsset: p.borrow.symbol,
      currentLtv: Number(p.ltv),
      liquidationThreshold: Number(p.liquidationLtv ?? p.market?.lltv ?? 0.9),
      collateralBalanceUsd: collateralUsd,
      borrowBalanceUsd: borrowUsd,
      seizePct,
      expectedSeizeUsd,
      oracleFreshnessSec: 5, // Morpho uses on-chain oracle, typically fresh
      gasPriceGwei: Number((await client.getGasPrice()) / 1_000_000_000n),
      estimatedExecutionGas: estimateGas("morpho-blue"),
      recentPriceMovePct30m: 0, // TODO: compute from price history
      cascadeScore: 0, // TODO: compute from recent liquidations
      competitionLast10Blocks: 0, // TODO: compute from mempool
      ageBlocks: 999, // Morpho positions don't have age in subgraph
    });
  }

  return candidates;
}

export async function scanIonicChronic(client: PublicClient, ethPriceUsd: number): Promise<LiquidationCandidate[]> {
  const candidates: LiquidationCandidate[] = [];

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

      const seizePct = estimateSeizePct("ionic");
      const expectedSeizeUsd = borrowUsd * seizePct;

      if (expectedSeizeUsd < 500) continue;

      candidates.push({
        protocol: "ionic",
        borrower: borrower as `0x${string}`,
        collateralAsset: "IONIC_COLLATERAL", // placeholder - needs real token resolution
        borrowAsset: "IONIC_DEBT",
        currentLtv: ltv,
        liquidationThreshold: 0.9,
        collateralBalanceUsd: collateralUsd,
        borrowBalanceUsd: borrowUsd,
        seizePct,
        expectedSeizeUsd,
        oracleFreshnessSec: 300, // Ionic is slower
        gasPriceGwei: Number((await client.getGasPrice()) / 1_000_000_000n),
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
  return [...morpho, ...ionic];
}
