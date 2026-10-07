// Prep facts for src/lib/exit.ts (empirical exit measurement):
//   1. which pools exist for the live (collateral, loan) pairs — univ3 uint24
//      tiers, slipstream int24 tickSpacings, aero-v2 stable/volatile;
//   2. does any Aerodrome-V2 fee getter exist (else assume 0.3%/0.05%);
//   3. does a 32-quote PoolQuoter batch fit in one eth_call.
// Run: ./node_modules/.bin/tsx jnk/exit-prep.mts
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, zeroAddress, type Hex, type Abi } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.QUOTE_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const UNIV3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
const SLIPSTREAM = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as const;
const AERO_V2 = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const SCRATCH = "0x1337133713371337133713371337133713371337" as const;

const V3_UINT24 = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CL_INT24 = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const V2_STABLE = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V2_GETFEE = parseAbi(["function getFee(address) view returns (uint256)", "function getFee(bool) view returns (uint256)", "function getFee() view returns (uint256)"]);

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USR = "0x35E5dB674D8e93a03d814FA0ADa70731efe8a4b9" as const;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const USDA = "0x0000206329b97DB379d5E1Bf586BbDB969C63274" as const;

const pairs: Array<[string, `0x${string}`, `0x${string}`]> = [
  ["cbETH/USDC", CBETH, USDC],
  ["USR/USDC", USR, USDC],
  ["WETH/USDC", WETH, USDC],
  ["WETH/cbBTC", WETH, CBBTC],
  ["cbETH/USDA", CBETH, USDA],
];

async function walk(factory: `0x${string}`, abi: Abi, label: string, tiers: number[], a: `0x${string}`, b: `0x${string}`) {
  const hits: string[] = [];
  for (const t of tiers) {
    try {
      const pool = (await client.readContract({ address: factory, abi, functionName: "getPool", args: [a, b, t as never] })) as `0x${string}`;
      if (pool !== zeroAddress) hits.push(`${t}:${pool}`);
    } catch {
      hits.push(`${t}:REVERT`);
      break;
    }
  }
  if (hits.length) console.log(`  ${label}: ${hits.join(" ")}`);
}

async function main() {
  for (const [label, a, b] of pairs) {
    console.log(`${label}:`);
    await walk(UNIV3, V3_UINT24, "univ3  ", [100, 500, 3000, 10000], a, b);
    await walk(SLIPSTREAM, CL_INT24, "slip   ", [1, 20, 50, 100, 200, 500, 1000, 3000, 5000], a, b);
    for (const stable of [false, true]) {
      try {
        const pool = (await client.readContract({ address: AERO_V2, abi: V2_STABLE, functionName: "getPool", args: [a, b, stable] })) as `0x${string}`;
        if (pool !== zeroAddress) console.log(`  aero-v2 stable=${stable}: ${pool}`);
      } catch {
        console.log(`  aero-v2 stable=${stable}: ERR`);
      }
    }
  }

  console.log("\naero-v2 fee getters (factory):");
  for (const [label, fn, args] of [
    ["getFee(address)", "getFee", [WETH]],
    ["getFee(bool)", "getFee", [false]],
    ["getFee()", "getFee", []],
  ] as const) {
    try {
      const fee = await client.readContract({ address: AERO_V2, abi: V2_GETFEE, functionName: fn as never, args: args as never });
      console.log(`  ${label} -> ${fee}`);
    } catch (e: any) {
      console.log(`  ${label} -> REVERT (${String(e?.shortMessage ?? e).slice(0, 60)})`);
    }
  }

  // 32-quote batch: realistic ~$20K-$100K swaps across the known-good pools.
  const artifact = JSON.parse(readFileSync("contracts/out/PoolQuoter.json", "utf8")) as { abi: any; deployedBytecode: Hex };
  const QUOTER_ABI = parseAbi([
    "function quoteBatch((address pool,bool zeroForOne,uint256 amountIn)[] quotes) returns (uint256[] consumed, uint256[] received)",
  ]);
  const u3w = "0x6c561B446416E1A00E8E93E221854d6eA4171372" as const;
  const quotes = Array.from({ length: 32 }, (_, i) => ({
    pool: u3w,
    zeroForOne: true,
    amountIn: BigInt(1 + i * 3) * 10n ** 16n, // 0.01 .. ~0.97 WETH, mixed tick-crossing depth
  }));
  for (const n of [32, 16, 8]) {
    const t0 = Date.now();
    try {
      const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteBatch", args: [quotes.slice(0, n)] });
      const res = await client.call({ to: SCRATCH, data, stateOverride: [{ address: SCRATCH, code: artifact.deployedBytecode }], gas: 50_000_000n });
      const [consumed] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteBatch", data: res.data! });
      const used = consumed.filter((c: bigint) => c > 0n).length;
      console.log(`\nbatch of ${n}: OK in ${Date.now() - t0}ms (${used}/${n} quotes got liquidity, gas cap 50M)`);
      break;
    } catch (e: any) {
      console.log(`\nbatch of ${n}: FAIL in ${Date.now() - t0}ms (${String(e?.shortMessage ?? e).slice(0, 90)})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
