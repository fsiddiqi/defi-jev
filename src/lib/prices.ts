import { parseAbi, type PublicClient } from "viem";

// ── Price facts ──────────────────────────────────────────────────────────────
// "No fictions, only facts." Two independent on-chain price sources:
//
//  - oracle: the Morpho market's on-chain oracle (price()). This is what the
//    protocol ACTUALLY uses to compute health factors and run liquidations —
//    authoritative for how much collateral a liquidator receives per dollar of
//    debt repaid. But it is a NOMINAL price for illiquid collateral (it can be
//    a peg/MMA feed that says $1 for a token nobody trades).
//  - dex: a real on-chain pool on Base (Aerodrome V2/V3). Authoritative for
//    what seized collateral can actually be sold for, and how deep the book is.
//
// When neither usable figure exists, the caller sets priceSource "none" and the
// candidate is honestly unrealizable (profit treated as $0). We never invent a
// sale price.

export const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
export const WETH_ADDRESS = (process.env.WETH_ADDRESS ?? "0x4200000000000000000000000000000000000006") as `0x${string}`;
const USDBC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as const;

export const QUOTE_SYMBOLS: Record<string, string> = {
  [USDC_ADDRESS.toLowerCase()]: "USDC",
  [WETH_ADDRESS.toLowerCase()]: "WETH",
  [USDBC_ADDRESS.toLowerCase()]: "USDbC",
};

export const QUOTE_DECIMALS: Record<string, number> = {
  [USDC_ADDRESS.toLowerCase()]: 6,
  [WETH_ADDRESS.toLowerCase()]: 18,
  [USDBC_ADDRESS.toLowerCase()]: 6,
};

const DEX_V2_FACTORY = (process.env.DEX_V2_FACTORY ?? "0x420DD381b31aEf6683db6B902084cB0FFECe40Da") as `0x${string}`;
const DEX_V3_FACTORY = (process.env.DEX_V3_FACTORY ?? "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A") as `0x${string}`;
const DEX_QUOTE_TOKENS = (
  process.env.DEX_QUOTE_TOKENS ??
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,0x4200000000000000000000000000000000000006"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DEX_USE_V3 = process.env.DEX_USE_V3 !== "false";
const DEX_TTL_MS = Number(process.env.DEX_PRICE_TTL_SEC ?? "300") * 1000;
const ORACLE_AGE_TTL_MS = Number(process.env.ORACLE_AGE_TTL_SEC ?? "60") * 1000;

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const UPDATED_AT_ABI = parseAbi(["function updatedAt() view returns (uint256)"]);
const V2_FACTORY_ABI = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V2_POOL_ABI = parseAbi([
  "function getReserves() view returns (uint256,uint256)",
  "function token0() view returns (address)",
]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);

export interface DexQuote {
  dexPriceUsd: number;      // USD per collateral token (spot)
  exitLiquidityUsd: number; // one-sided pool depth in USD at spot
  venue: string;            // e.g. "aerodrome-v2 USR/USDC (stable)"
  v3: boolean;
}

// ── Pure pool math (unit-testable, no RPC) ──────────────────────────────────

export interface PoolQuote {
  priceUsd: number;
  depthUsd: number;
}

// Aerodrome/Uniswap V2 (constant product). Spot price from the reserve ratio;
// one-sided depth = the USD value of the smaller side (what the pool can absorb
// before the book is exhausted on one side).
export function v2Quote(
  reserves: [bigint, bigint],
  collDecimals: number,
  quoteDecimals: number,
  token0IsCollateral: boolean,
  quoteUsd: number,
): PoolQuote {
  const r0 = Number(reserves[0]);
  const r1 = Number(reserves[1]);
  if (r0 <= 0 || r1 <= 0) return { priceUsd: 0, depthUsd: 0 };
  const rColl = token0IsCollateral ? r0 : r1;
  const rQuote = token0IsCollateral ? r1 : r0;
  const collTokens = rColl / 10 ** collDecimals;
  const quoteTokens = rQuote / 10 ** quoteDecimals;
  if (collTokens <= 0) return { priceUsd: 0, depthUsd: 0 };
  const priceUsd = (quoteTokens / collTokens) * quoteUsd;
  const depthUsd = Math.min(collTokens * priceUsd, quoteTokens * quoteUsd);
  return { priceUsd, depthUsd };
}

// Uniswap V3 / Aerodrome CL. sqrtPriceX96 = sqrt(token1/token0) in Q64.96
// decimal-normalized space, token0/1 ordered by address. Spot price is exact
// from slot0. One-sided depth is an APPROXIMATION: quote amount absorbed when
// moving the price ±rangeWidthPct from spot against the in-range liquidity:
//   Δy_raw ≈ L * Δ√P = L * sp * (√(1+δ) − √(1−δ))
// This under-measures full-range depth for thin books, which is the direction
// a conservative gate wants. Marked "(approx depth)" in the venue string.
export function v3Quote(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  collDecimals: number,
  quoteDecimals: number,
  token0IsCollateral: boolean,
  quoteUsd: number,
  rangeWidthPct = 0.1,
): PoolQuote {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) return { priceUsd: 0, depthUsd: 0 };
  const sp = Number(sqrtPriceX96) / 2 ** 96; // sqrt(P) in real units
  const sq = sp * sp;
  // V3 convention: token1 per token0 = sp^2 * 10^(dec0 - dec1).
  let quotePerColl: number;
  if (token0IsCollateral) {
    // coll is token0, quote is token1
    quotePerColl = sq * 10 ** (collDecimals - quoteDecimals);
  } else {
    // coll is token1, quote is token0: token1-per-token0 = sq * 10^(quoteDec - collDec)
    quotePerColl = 1 / Math.max(sq * 10 ** (quoteDecimals - collDecimals), 1e-30);
  }
  const priceUsd = quotePerColl * quoteUsd;
  if (priceUsd <= 0) return { priceUsd: 0, depthUsd: 0 };
  const deltaSqrt = Math.sqrt(1 + rangeWidthPct) - Math.sqrt(1 - rangeWidthPct);
  const depthRawQuote = Number(liquidity) * sp * deltaSqrt;
  const depthUsd = Math.max(0, (depthRawQuote / 10 ** quoteDecimals) * quoteUsd);
  return { priceUsd, depthUsd };
}

// ── On-chain readers (RPC, memoized) ────────────────────────────────────────

// True oracle age: Morpho oracles frequently expose Chainlink's latestRoundData
// (answer + updatedAt) or an MMA-style updatedAt(). Fall back to null when the
// feed exposes neither — then the caller keeps the previous freshness default.
const oracleAgeCache = new Map<string, { ageSec: number | null; at: number }>();
export async function readOracleAgeSec(
  client: PublicClient,
  oracleAddr: `0x${string}`,
): Promise<number | null> {
  const key = oracleAddr.toLowerCase();
  const hit = oracleAgeCache.get(key);
  if (hit && Date.now() - hit.at < ORACLE_AGE_TTL_MS) return hit.ageSec;
  let ageSec: number | null = null;
  try {
    const [, , , updatedAt] = (await client.readContract({
      address: oracleAddr,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
  } catch {
    try {
      const updatedAt = (await client.readContract({
        address: oracleAddr,
        abi: UPDATED_AT_ABI,
        functionName: "updatedAt",
      })) as bigint;
      ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
    } catch {
      ageSec = null;
    }
  }
  oracleAgeCache.set(key, { ageSec, at: Date.now() });
  return ageSec;
}

// Find the deepest single-hop pool for `collateralToken` against the configured
// quote tokens (USDC/WETH by default), across Aerodrome V2 (stable+volatile)
// and V3 (100/500/3000/10000 bps). Returns the pool with the largest one-sided
// depth, or null when the collateral has no verifiable exit venue at all.
const dexCache = new Map<string, { quote: DexQuote | null; at: number }>();
export async function findDexPool(
  client: PublicClient,
  collateralToken: `0x${string}`,
  collateralDecimals: number,
  collateralSymbol: string,
  quoteUsdMap: Record<string, number>,
): Promise<DexQuote | null> {
  const key = collateralToken.toLowerCase();
  const hit = dexCache.get(key);
  if (hit && Date.now() - hit.at < DEX_TTL_MS) return hit.quote;

  const coll = collateralToken.toLowerCase() as `0x${string}`;
  const quotes = DEX_QUOTE_TOKENS.filter((q) => q !== coll);
  const results: DexQuote[] = [];

  await Promise.all(
    quotes.map(async (q) => {
      const quoteUsd = quoteUsdMap[q] ?? 1;
      const quoteDecimals = QUOTE_DECIMALS[q] ?? 18;
      const qSym = QUOTE_SYMBOLS[q] ?? `${q.slice(0, 6)}…`;

      for (const stable of [true, false]) {
        try {
          const pool = (await client.readContract({
            address: DEX_V2_FACTORY,
            abi: V2_FACTORY_ABI,
            functionName: "getPool",
            args: [coll, q as `0x${string}`, stable],
          })) as `0x${string}`;
          if (pool === "0x0000000000000000000000000000000000000000") continue;
          const [reserves, t0] = await Promise.all([
            client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: "getReserves" }),
            client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: "token0" }),
          ]);
          const token0IsCollateral = (t0 as `0x${string}`).toLowerCase() === coll;
          const { priceUsd, depthUsd } = v2Quote(
            reserves as [bigint, bigint],
            collateralDecimals,
            quoteDecimals,
            token0IsCollateral,
            quoteUsd,
          );
          if (priceUsd > 0 && depthUsd > 0) {
            results.push({
              dexPriceUsd: priceUsd,
              exitLiquidityUsd: depthUsd,
              venue: `aerodrome-v2 ${collateralSymbol}/${qSym} ${stable ? "stable" : "volatile"}`,
              v3: false,
            });
          }
        } catch {
          // pool read failed — skip this candidate pool
        }
      }

      if (DEX_USE_V3) {
        for (const fee of [100, 500, 3000, 10000]) {
          try {
            const pool = (await client.readContract({
              address: DEX_V3_FACTORY,
              abi: V3_FACTORY_ABI,
              functionName: "getPool",
              args: [coll, q as `0x${string}`, fee],
            })) as `0x${string}`;
            if (pool === "0x0000000000000000000000000000000000000000") continue;
            const [slot0, liquidity, t0] = await Promise.all([
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" }),
              client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "token0" }),
            ]);
            const token0IsCollateral = (t0 as `0x${string}`).toLowerCase() === coll;
            const { priceUsd, depthUsd } = v3Quote(
              slot0[0] as bigint,
              liquidity as bigint,
              collateralDecimals,
              quoteDecimals,
              token0IsCollateral,
              quoteUsd,
            );
            if (priceUsd > 0 && depthUsd > 0) {
              results.push({
                dexPriceUsd: priceUsd,
                exitLiquidityUsd: depthUsd,
                venue: `aerodrome-v3 ${collateralSymbol}/${qSym} ${(fee / 10000).toFixed(2)}% (approx depth)`,
                v3: true,
              });
            }
          } catch {
            // pool read failed — skip
          }
        }
      }
    }),
  );

  const best = results.sort((a, b) => b.exitLiquidityUsd - a.exitLiquidityUsd)[0] ?? null;
  dexCache.set(key, { quote: best, at: Date.now() });
  return best;
}