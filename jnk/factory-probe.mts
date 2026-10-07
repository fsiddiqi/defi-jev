// Probe every factory x ABI x tier combo for getPool on representative pairs,
// to settle (empirically, no docs): which selectors each factory actually
// implements, which tiers exist, and whether the legacy prices.ts V3 path is
// dead. Run: ./node_modules/.bin/tsx jnk/factory-probe.mts
import { createPublicClient, http, parseAbi, zeroAddress, type Abi } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http(process.env.QUOTE_RPC ?? "https://base-rpc.publicnode.com") });

const UNIV3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
const SLIPSTREAM = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as const;
const AERO_V2 = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;

const V3_UINT24 = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CL_INT24 = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const V2_STABLE = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V2_FEE1 = parseAbi(["function getFee(address) view returns (uint256)"]);
const V2_FEE2 = parseAbi(["function getFee(bool) view returns (uint256)"]);
const V2_FEE3 = parseAbi(["function getFee() view returns (uint256)"]);

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USDE = "0x40D16FC02462D1Ee63d80071644B7C7c403B2998" as const;
const USR = "0x4235850F6b1b5D7b9C89D6C5E1B6cD3E2B8f3d8e" as const; // may be wrong; skip if pair empty

const pairs: Array<[string, `0x${string}`, `0x${string}`]> = [
  ["cbETH/WETH", CBETH, WETH],
  ["cbETH/USDC", CBETH, USDC],
  ["WETH/USDC", WETH, USDC],
  ["USDe/USDC", USDE, USDC],
  ["USR/USDC", USR, USDC],
];

async function walkV3(factory: `0x${string}`, abi: Abi, label: string, tiers: number[], a: `0x${string}`, b: `0x${string}`, pairLabel: string) {
  for (const t of tiers) {
    try {
      const pool = (await client.readContract({ address: factory, abi, functionName: "getPool", args: [a, b, t as never] })) as `0x${string}`;
      if (pool !== zeroAddress) console.log(`  ${pairLabel} ${label} tier=${t} -> ${pool}`);
    } catch (e: any) {
      console.log(`  ${pairLabel} ${label} tier=${t} REVERT/ERR: ${String(e?.shortMessage ?? e).slice(0, 90)}`);
      return; // selector-level failure: stop walking this combo
    }
  }
}

async function main() {
  for (const [label, a, b] of pairs) {
    console.log(`${label}:`);
    await walkV3(UNIV3, V3_UINT24, "univ3/uint24", [100, 500, 3000, 10000], a, b, label);
    await walkV3(SLIPSTREAM, V3_UINT24, "slip/uint24", [100, 500, 3000, 10000], a, b, label);
    await walkV3(SLIPSTREAM, CL_INT24, "slip/int24", [1, 20, 50, 100, 200, 500, 1000, 3000], a, b, label);
    for (const stable of [false, true]) {
      try {
        const pool = (await client.readContract({ address: AERO_V2, abi: V2_STABLE, functionName: "getPool", args: [a, b, stable] })) as `0x${string}`;
        if (pool !== zeroAddress) console.log(`  ${label} aero-v2 stable=${stable} -> ${pool}`);
      } catch (e: any) {
        console.log(`  ${label} aero-v2 stable=${stable} ERR: ${String(e?.shortMessage ?? e).slice(0, 90)}`);
      }
    }
  }

  // Fee lookup on an existing aero-v2 pool (volatile + stable), if any.
  console.log("\naerodrome-v2 factory fee getters:");
  const anyV2 = (await client.readContract({ address: AERO_V2, abi: V2_STABLE, functionName: "getPool", args: [WETH, USDC, false] })) as `0x${string}`;
  if (anyV2 !== zeroAddress) {
    for (const [name, abi, args] of [
      ["getFee(address)", V2_FEE1, [anyV2]],
      ["getFee(bool)", V2_FEE2, [false]],
      ["getFee()", V2_FEE3, []],
    ] as const) {
      try {
        const fee = await client.readContract({ address: AERO_V2, abi, functionName: "getFee" as never, args: args as never });
        console.log(`  ${name} -> ${fee}`);
      } catch (e: any) {
        console.log(`  ${name} REVERT: ${String(e?.shortMessage ?? e).slice(0, 80)}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
