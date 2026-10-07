// Route discovery + exit quoting for a liquidation's collateral → loan swap.
// Ported from jnk/target-scan (proven on the live sweep):
//   - single-hop pools only, across 3 factories (UniV3 / Slipstream CL / Aero V2)
//   - V3/Slipstream denominated quotes via PoolQuoter (state-overridden eth_call)
//   - Aero V2 quotes from local reserves math with the assumed fee
// Chain-agnostic: venues per chainId. Base is wired; other chains are added as
// they come online (see docs/multichain-research.md).
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── venue registry ───────────────────────────────────────────────────────────
export interface Venues {
  v3Factory: Address; // getPool(a, b, fee)
  clFactory: Address; // getPool(a, b, tickSpacing) — Slipstream / CL fork
  v2Factory: Address; // getPool(a, b, stable) — Aero/Velodrome V2
}

export const VENUES: Record<number, Venues> = {
  // Base
  8453: {
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    clFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    v2Factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  },
};

export const UNIV3_TIERS = [100, 500, 3000, 10000] as const;
export const SLIPSTREAM_SPACINGS = [1, 20, 50, 100, 200, 500, 1000] as const;
export const AERO_V2_FEE_BPS = 30n; // volatile
export const AERO_V2_STABLE_FEE_BPS = 5n;

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

export interface Route {
  kind: "v3" | "v2";
  pool: Address;
  label: string;
  /** input token is token0 of the pool */
  zeroForOne: boolean;
  stable?: boolean;
}

let quoterBytecode: Hex | null = null;
function loadQuoterBytecode(): Hex | null {
  if (quoterBytecode) return quoterBytecode;
  try {
    const raw = readFileSync(join(process.cwd(), "contracts", "out", "PoolQuoter.json"), "utf8");
    quoterBytecode = (JSON.parse(raw) as { deployedBytecode: Hex }).deployedBytecode;
  } catch {
    quoterBytecode = null;
  }
  return quoterBytecode;
}

// Only place where the bytecode (a chain-agnostic staticcall read-only
// contract) is injected into eth_call — same trick that produced the
// execution-exact quotes in jnk/exit-prep.
const SCRATCH = "0x1337133713371337133713371337133713371337" as const;

/** All single-hop pools for (coll, loan) on a chain, input = collateral token. */
export async function findSingleHopRoutes(
  client: PublicClient,
  chainId: number,
  coll: Address,
  loan: Address,
): Promise<Route[]> {
  const venues = VENUES[chainId];
  if (!venues) return [];
  const collIs0 = coll.toLowerCase() < loan.toLowerCase();

  const hits = await Promise.all([
    ...UNIV3_TIERS.map((t) =>
      client.readContract({ address: venues.v3Factory, abi: FACTORY_ABIS.v3, functionName: "getPool", args: [coll, loan, t] }).catch(() => zeroAddress),
    ),
    ...SLIPSTREAM_SPACINGS.map((s) =>
      client.readContract({ address: venues.clFactory, abi: FACTORY_ABIS.cl, functionName: "getPool", args: [coll, loan, s] }).catch(() => zeroAddress),
    ),
    client.readContract({ address: venues.v2Factory, abi: FACTORY_ABIS.v2, functionName: "getPool", args: [coll, loan, false] }).catch(() => zeroAddress),
    client.readContract({ address: venues.v2Factory, abi: FACTORY_ABIS.v2, functionName: "getPool", args: [coll, loan, true] }).catch(() => zeroAddress),
  ]);

  const routes: Route[] = [];
  let i = 0;
  for (const t of UNIV3_TIERS) {
    const p = hits[i++];
    if (p !== zeroAddress) routes.push({ kind: "v3", pool: p, label: `univ3 f${t}`, zeroForOne: collIs0 });
  }
  for (const s of SLIPSTREAM_SPACINGS) {
    const p = hits[i++];
    if (p !== zeroAddress) routes.push({ kind: "v3", pool: p, label: `slip ts${s}`, zeroForOne: collIs0 });
  }
  const vol = hits[i++];
  const sta = hits[i++];
  if (vol !== zeroAddress) routes.push({ kind: "v2", pool: vol, label: "aero-v2 volatile", zeroForOne: collIs0, stable: false });
  if (sta !== zeroAddress) routes.push({ kind: "v2", pool: sta, label: "aero-v2 stable", zeroForOne: collIs0, stable: true });
  return routes;
}

/** PoolQuoter-denominated quote for a V3/Slipstream pool (exact-in). */
export async function quoteV3(
  client: PublicClient,
  pool: Address,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<bigint | null> {
  const bc = loadQuoterBytecode();
  if (!bc) return null;
  try {
    const data = encodeFunctionData({
      abi: QUOTER_ABI,
      functionName: "quoteBatch",
      args: [[{ pool, zeroForOne, amountIn }]],
    });
    const res = await client.call({
      to: SCRATCH,
      data,
      stateOverride: [{ address: SCRATCH, code: bc }],
    });
    if (!res.data) return null;
    const [, received] = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: "quoteBatch",
      data: res.data,
    });
    return (received as bigint[])[0];
  } catch {
    return null;
  }
}

/** Local-reserves quote for an Aero/Velodrome V2 pool (exact-in, fee applied). */
export async function quoteV2(
  client: PublicClient,
  pool: Address,
  zeroForOne: boolean,
  amountIn: bigint,
  stable: boolean,
): Promise<bigint | null> {
  try {
    const reserves = await client.readContract({ address: pool, abi: PAIR_ABI, functionName: "getReserves" });
    const [r0, r1] = reserves;
    const rIn = zeroForOne ? r0 : r1;
    const rOut = zeroForOne ? r1 : r0;
    if (rIn === 0n || rOut === 0n) return null;
    const feeBps = stable ? AERO_V2_STABLE_FEE_BPS : AERO_V2_FEE_BPS;
    const amtInF = amountIn * (10_000n - feeBps);
    return (amtInF * rOut) / (rIn * 10_000n + amtInF);
  } catch {
    return null;
  }
}

export async function quoteRoute(
  client: PublicClient,
  route: Route,
  amountIn: bigint,
): Promise<bigint | null> {
  return route.kind === "v3"
    ? quoteV3(client, route.pool, route.zeroForOne, amountIn)
    : quoteV2(client, route.pool, route.zeroForOne, amountIn, route.stable ?? false);
}

export interface BestExit {
  route: Route;
  /** exact input collateral wei */
  amountIn: bigint;
  /** loan wei received by the contract */
  proceeds: bigint;
  /** fraction of the position taken (1..0.05) */
  sizeFrac: number;
}

/**
 * Ladder-search the best single-hop exit that clears `repayLoan` loan wei,
 * selling at most `seizeCollCap` collateral wei. Returns null when no route
 * clears the debt at any rung (position is unexecutable — this is the honest
 * `proceeds < repay` verdict from the sweep).
 */
export async function pickBestExit(
  client: PublicClient,
  chainId: number,
  coll: Address,
  loan: Address,
  seizeCollCap: bigint,
  repayLoan: bigint,
  routes?: Route[],
): Promise<BestExit | null> {
  const found = routes ?? (await findSingleHopRoutes(client, chainId, coll, loan));
  if (found.length === 0) return null;

  const fracs = [1, 0.5, 0.25, 0.1, 0.05];
  let best: BestExit | null = null;
  for (const fr of fracs) {
    const amtIn = (seizeCollCap * BigInt(Math.round(fr * 1e6))) / 1_000_000n;
    const repayFrac = (repayLoan * BigInt(Math.round(fr * 1e6))) / 1_000_000n;
    if (amtIn === 0n || repayFrac === 0n) continue;
    for (const rt of found) {
      const got = await quoteRoute(client, rt, amtIn);
      if (got == null || got === 0n) continue;
      if (got >= repayFrac && (!best || got > best.proceeds)) {
        best = { route: rt, amountIn: amtIn, proceeds: got, sizeFrac: fr };
      }
    }
  }
  return best;
}