// Venue depth for cbETH exit routes (direct + via WETH), to pick the swap
// router for MorphoFlashLiquidator. Run: ./node_modules/.bin/tsx jnk/venue-recon.mts
import "dotenv/config";
import { createPublicClient, http, parseAbi, type Abi } from "viem";
import { base } from "viem/chains";
import { v2Quote, v3Quote } from "../src/lib/prices.js";

const client = createPublicClient({ chain: base, transport: http(process.env.SIM_RPC ?? "https://base-rpc.publicnode.com") });

const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const WSTETH = "0xc1CBa3fCea344f92d9238908e33f58439ca389f1" as const;
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
]);

const ETH_USD = 2560; // approx for depth display only

async function v2Depth(coll: `0x${string}`, q: `0x${string}`, qDec: number, qUsd: number, stable: boolean, label: string) {
  try {
    const pool = await client.readContract({ address: AERO_V2_FACTORY, abi: V2F, functionName: "getPool", args: [coll, q, stable] });
    if (pool === "0x0000000000000000000000000000000000000000") return;
    const [r, t0] = await Promise.all([
      client.readContract({ address: pool, abi: V2P, functionName: "getReserves" }),
      client.readContract({ address: pool, abi: V2P, functionName: "token0" }),
    ]);
    const { priceUsd, depthUsd } = v2Quote(r as any, 18, qDec, (t0 as string).toLowerCase() === coll.toLowerCase(), qUsd);
    if (depthUsd > 0) console.log(`  ${label} pool=${pool} price=$${priceUsd.toFixed(2)} depth=$${depthUsd.toFixed(0)}`);
  } catch { /* none */ }
}

async function clDepth(coll: `0x${string}`, q: `0x${string}`, qDec: number, qUsd: number, factory: `0x${string}`, abi: Abi, tiers: (number | bigint)[], label: string, collDec = 18) {
  for (const fee of tiers) {
    try {
      const pool = await client.readContract({ address: factory, abi, functionName: "getPool", args: [coll, q, fee as any] });
      if (pool === "0x0000000000000000000000000000000000000000") continue;
      const [s0, liq, t0] = await Promise.all([
        client.readContract({ address: pool, abi: V3P, functionName: "slot0" }),
        client.readContract({ address: pool, abi: V3P, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: V3P, functionName: "token0" }),
      ]);
      const { priceUsd, depthUsd } = v3Quote((s0 as any)[0], liq as any, collDec, qDec, (t0 as string).toLowerCase() === coll.toLowerCase(), qUsd);
      if (depthUsd > 0) console.log(`  ${label} fee=${fee} pool=${pool} price=$${priceUsd.toFixed(2)} depth=$${depthUsd.toFixed(0)}`);
    } catch { /* none */ }
  }
}

async function main() {
  for (const [sym, tok] of [["cbETH", CBETH], ["wstETH", WSTETH]] as const) {
    console.log(`\n${sym} exits:`);
    await v2Depth(tok, USDC, 6, 1, true, `aero-v2 ${sym}/USDC stable`);
    await v2Depth(tok, USDC, 6, 1, false, `aero-v2 ${sym}/USDC volatile`);
    await v2Depth(tok, WETH, 18, ETH_USD, false, `aero-v2 ${sym}/WETH volatile`);
    await v2Depth(tok, WETH, 18, ETH_USD, true, `aero-v2 ${sym}/WETH stable`);
    await clDepth(tok, USDC, 6, 1, SLIPSTREAM, CLF as Abi, [100, 200, 500, 1000], `slipstream ${sym}/USDC`);
    await clDepth(tok, WETH, 18, ETH_USD, SLIPSTREAM, CLF as Abi, [100, 200, 500, 1000], `slipstream ${sym}/WETH`);
    await clDepth(tok, USDC, 6, 1, UNIV3, V3F as Abi, [100, 500, 3000, 10000], `univ3 ${sym}/USDC`);
    await clDepth(tok, WETH, 18, ETH_USD, UNIV3, V3F as Abi, [100, 500, 3000, 10000], `univ3 ${sym}/WETH`);
  }

  // second hop depth
  console.log(`\nWETH→USDC hop:`);
  await v2Depth(WETH, USDC, 6, 1, false, "aero-v2 WETH/USDC volatile");
  await clDepth(USDC, WETH, 18, ETH_USD, UNIV3, V3F as Abi, [100, 500, 3000, 10000], "univ3 WETH/USDC (sym)", 6);
  await clDepth(WETH, USDC, 6, 1, UNIV3, V3F as Abi, [100, 500, 3000, 10000], "univ3 WETH/USDC");
  await clDepth(WETH, USDC, 6, 1, SLIPSTREAM, CLF as Abi, [100, 200, 500, 1000], "slipstream WETH/USDC");

  // routers have code?
  for (const [name, addr] of [
    ["univ3 SwapRouter02", "0x2621360658402030f2F219782B37666992d1921c"],
    ["universal router", "0x2626664c2603336E57B271c5C0b26F421741e481"],
    ["aerodrome router", "0xcF77a3Ba9A5CA399B7c97c74d54e5b18eb32d163"],
    ["aerodrome v2 router(old?)", "0x9c129393b00e7E3244F523e1F7Bd05700f32F7dB"],
  ] as const) {
    const code = await client.getBytecode({ address: addr as `0x${string}` }).catch(() => undefined);
    console.log(`router ${name} ${addr}: ${code && code !== "0x" ? `code ${code.length / 2 - 1} bytes` : "NO CODE"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
