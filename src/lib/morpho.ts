// On-chain truth for a Morpho Blue position/market — everything upstream of
// Jev and the executor is derived from these RPC reads, never from the
// subgraph's USD fields (which are corrupt for some markets).
//
// Ported from the proven jnk/target-scan logic; chain-agnostic (caller picks
// the PublicClient + Morpho address for any chain).
import { parseAbi, type Address, type PublicClient } from "viem";

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MarketTruth {
  marketId: Address;
  params: MorphoMarketParams;
  /** oracle price(): loan wei per 1e36 collateral wei */
  price: bigint;
  collDec: number;
  loanDec: number;
  // position (order per morpho-blue: supplyShares, borrowShares, collateral)
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  // market (totalBorrowAssets/Shares as reported)
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** debt in loan wei, ceil(borrowShares * totalBorrowAssets / totalBorrowShares) */
  debtAssets: bigint;
  /** collateral value in loan wei = collateral * price / 1e36 */
  collValueLoanWei: bigint;
  /** HF as wad = collValue * lltv / debt (0 when no debt) */
  healthFactorWad: bigint;
}

const MORPHO_ABI = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint256 totalSupplyAssets,uint256 totalSupplyShares,uint256 totalBorrowAssets,uint256 totalBorrowShares,uint48 lastUpdate,uint16 fee)",
  "function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

// ── cache ────────────────────────────────────────────────────────────────────
// Price barely moves and market/position state is what gates decisions on; a
// short TTL keeps scan hammering down without going stale between re-evals.
const TRUTH_TTL_MS = Number(process.env.ONCHAIN_TRUTH_TTL_SEC ?? "300") * 1000;
const truthCache = new Map<string, { t: MarketTruth; at: number }>();

function cacheKey(rpcLabel: string, marketId: Address): string {
  return `${rpcLabel}|${marketId.toLowerCase()}`;
}

/** 0.3 cursor / 1.15 cap — mirrors morpho-blue ConstantsLib + bot profit.ts */
export function incentiveFactorWad(lltv: bigint): bigint {
  const l = Number(lltv) / 1e18;
  const clamped = Math.min(Math.max(l, 0.001), 0.999);
  const f = 1 / (1 - 0.3 * (1 - clamped));
  const capped = Math.min(1.15, f);
  return BigInt(Math.round(capped * 1e18));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? 0n : (a + b - 1n) / b;
}

/** Seize/repay math for a debt-capped or collateral-capped full repay. */
export function seizeAndRepay(
  collateral: bigint,
  collValueLoanWei: bigint,
  debtAssets: bigint,
  lltv: bigint,
): { seizeLoan: bigint; repayLoan: bigint; seizeColl: bigint } {
  const fWad = incentiveFactorWad(lltv);
  const debtF = (debtAssets * fWad) / 10n ** 18n; // debt * f
  if (collValueLoanWei < debtF) {
    // collateral-capped: seize all collateral, repay collValue / f
    const repay = (collValueLoanWei * 10n ** 18n) / fWad;
    if (repay > debtAssets) return { seizeLoan: 0n, repayLoan: 0n, seizeColl: 0n };
    return { seizeLoan: collValueLoanWei, repayLoan: repay, seizeColl: collateral };
  }
  // debt-capped: repay all debt, seize a proportional slice of collateral
  const seizeColl = (collateral * debtF) / collValueLoanWei;
  return { seizeLoan: debtF, repayLoan: debtAssets, seizeColl };
}

export async function loadMarketTruth(
  client: PublicClient,
  rpcLabel: string,
  morpho: Address,
  marketId: Address,
  user?: Address,
  opts: { noCache?: boolean } = {},
): Promise<MarketTruth> {
  const key = cacheKey(rpcLabel, marketId);
  const hit = truthCache.get(key);
  if (!opts.noCache && hit && Date.now() - hit.at < TRUTH_TTL_MS) return hit.t;

  const [params, mkt] = await Promise.all([
    client.readContract({
      address: morpho,
      abi: MORPHO_ABI,
      functionName: "idToMarketParams",
      args: [marketId],
    }),
    client.readContract({
      address: morpho,
      abi: MORPHO_ABI,
      functionName: "market",
      args: [marketId],
    }),
  ]);

  const [price, collDec, loanDec] = await Promise.all([
    client.readContract({ address: params[2], abi: ORACLE_ABI, functionName: "price" }),
    client.readContract({ address: params[1], abi: DECIMALS_ABI, functionName: "decimals" }),
    client.readContract({ address: params[0], abi: DECIMALS_ABI, functionName: "decimals" }),
  ]);

  let pos: readonly [bigint, bigint, bigint] | null = null;
  if (user) {
    pos = await client.readContract({
      address: morpho,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [marketId, user],
    });
  }

  const totalBorrowAssets = mkt[2];
  const totalBorrowShares = mkt[3];
  const collateral = pos?.[2] ?? 0n;
  const borrowShares = pos?.[1] ?? 0n;
  const debtAssets = ceilDiv(borrowShares * totalBorrowAssets, totalBorrowShares);
  const collValueLoanWei = (collateral * price) / 10n ** 36n;
  const healthFactorWad =
    debtAssets > 0n && collValueLoanWei > 0n
      ? (collValueLoanWei * params[4]) / debtAssets
      : 0n;

  const t: MarketTruth = {
    marketId,
    params: {
      loanToken: params[0],
      collateralToken: params[1],
      oracle: params[2],
      irm: params[3],
      lltv: params[4],
    },
    price,
    collDec: Number(collDec),
    loanDec: Number(loanDec),
    supplyShares: pos?.[0] ?? 0n,
    borrowShares,
    collateral,
    totalBorrowAssets,
    totalBorrowShares,
    debtAssets,
    collValueLoanWei,
    healthFactorWad,
  };
  truthCache.set(key, { t, at: Date.now() });
  return t;
}