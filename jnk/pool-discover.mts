// Enumerate every existing pool for cbETH/WETH, cbETH/USDC, WETH/USDC across
// univ3 + slipstream + aero-v2, with raw liquidity/reserves (no depth model).
// Run: ./node_modules/.bin/tsx jnk/pool-discover.mts
import { createPublicClient, http, parseAbi, type Abi } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http(process.env.SIM_RPC ?? "https://base-rpc.publicnode.com") });

const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const AERO_V2_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const SLIPSTREAM = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as const;
const UNIV3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;

const V2F = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V3F = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CLF = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const V2P = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
const V3P = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function fee() view returns (uint24)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

async function v3pools(factory: `0x${string}`, abi: Abi, tiers: number[], a: string, b: string, label: string) {
  for (const fee of tiers) {
    try {
      const pool = await client.readContract({ address: factory, abi, functionName: "getPool", args: [a as any, b as any, fee as any] });
      if (pool === ZERO) continue;
      const [s0, liq, t0, f] = await Promise.all([
        client.readContract({ address: pool, abi: V3P, functionName: "slot0" }),
        client.readContract({ address: pool, abi: V3P, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: V3P, functionName: "token0" }),
        client.readContract({ address: pool, abi: V3P, functionName: "fee" }),
      ]);
      const price = (Number((s0 as any)[0]) / 2 ** 96) ** 2;
      console.log(`  ${label} tier=${fee} pool=${pool} tick=${(s0 as any)[1]} price(t1/t0)=${price} L=${liq} fee=${f} t0=${t0}`);
    } catch (e: any) {
      console.log(`  ${label} tier=${fee}: ERR ${String(e?.shortMessage ?? e).slice(0, 60)}`);
    }
  }
}

async function v2pool(factory: `0x${string}`, a: string, b: string, stable: boolean, label: string) {
  try {
    const pool = await client.readContract({ address: factory, abi: V2F, functionName: "getPool", args: [a as any, b as any, stable] });
    if (pool === ZERO) return;
    const [r, t0] = await Promise.all([
      client.readContract({ address: pool, abi: V2P, functionName: "getReserves" }),
      client.readContract({ address: pool, abi: V2P, functionName: "token0" }),
    ]);
    const [r0, r1] = r as [bigint, bigint, number];
    console.log(`  ${label} pool=${pool} reserves=${r0}/${r1} t0=${t0}`);
  } catch { /* none */ }
}

async function main() {
  for (const [sym, tok] of [["cbETH", CBETH], ["WETH", WETH]] as const) {
    for (const [qsym, q] of [["USDC", USDC], ["WETH", WETH]] as const) {
      if (qsym === sym) continue;
      console.log(`\n${sym}/${qsym}:`);
      await v3pools(UNIV3, V3F as Abi, [100, 500, 3000, 10000], tok, q, "univ3   ");
      await v3pools(SLIPSTREAM, CLF as Abi, [100, 200, 500, 1000], tok, q, "slipstr ");
      await v2pool(AERO_V2_FACTORY, tok, q, false, "aero-v2 volatile");
      await v2pool(AERO_V2_FACTORY, tok, q, true, "aero-v2 stable  ");
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
