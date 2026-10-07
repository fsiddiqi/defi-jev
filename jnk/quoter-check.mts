// PoolQuoter sanity check against known-good empirical observations.
//
// Validates that the state-injected PoolQuoter reproduces the exact swap
// results flash-sim.mts observed inside executeLiquidation:
//   1. 197.53 WETH -> USDC through univ3 f3000 delivered ~$505K (full liquidation)
//   2. 48.45 cbETH -> WETH through univ3 f100 crashed out of its ~5-tick band
//      (48.45 in, only ~9.465 WETH out — the band-exhaustion case, where
//      consumed < amountIn must be reported honestly)
//   3. small trades price close to spot (no band nonsense)
//
// Run: ./node_modules/.bin/tsx jnk/quoter-check.mts
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const SCRATCH = "0x1337133713371337133713371337133713371337" as const;
const UNIV3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const U3_WETH_USDC_3000 = "0x6c561B446416E1A00E8E93E221854d6eA4171372" as const;

const artifact = JSON.parse(readFileSync("contracts/out/PoolQuoter.json", "utf8")) as {
  abi: any; bytecode: Hex; deployedBytecode: Hex;
};
const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const QUOTER_ABI = parseAbi([
  "function quoteBatch((address pool,bool zeroForOne,uint256 amountIn)[] quotes) returns (uint256[] consumed, uint256[] received)",
]);

async function quote(entries: Array<{ pool: `0x${string}`; zeroForOne: boolean; amountIn: bigint }>) {
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteBatch", args: [entries] });
  const res = await client.call({
    to: SCRATCH,
    data,
    stateOverride: [{ address: SCRATCH, code: artifact.deployedBytecode }],
  });
  if (!res.data) throw new Error("empty eth_call result (override not applied?)");
  const [consumed, received] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteBatch", data: res.data });
  return entries.map((e, i) => ({ ...e, consumed: consumed[i], received: received[i] }));
}

const e18 = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // ~1e-6 precision ok for checks

async function main() {
  // Resolve the cbETH/WETH 0.01% pool (the band-exhaustion specimen)
  const cbethWeth100 = (await client.readContract({
    address: UNIV3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [CBETH, WETH, 100],
  })) as `0x${string}`;

  console.log(`quoter eth_call ${RPC} (state-injected at ${SCRATCH})`);
  console.log(`cbETH/WETH f100 from factory = ${cbethWeth100}`);
  console.log(`WETH/USDC f3000 (const)     = ${U3_WETH_USDC_3000}`);
  const results = await quote([
    // 1. flash-sim's full-position exit: 197.53 WETH -> USDC, expect ~$505K
    { pool: U3_WETH_USDC_3000, zeroForOne: true, amountIn: e18(197.53) },
    // 2. band exhaustion: 48.45 cbETH -> WETH, expect consumed < amountIn, ~9.47 WETH
    { pool: cbethWeth100, zeroForOne: false, amountIn: e18(48.45) },
    // 3. small fair trade: 1 WETH -> USDC ~ spot (~$2.5K)
    { pool: U3_WETH_USDC_3000, zeroForOne: true, amountIn: e18(1) },
    // 4. probe where NO liquidity exists for the size: 100k WETH -> expect partial/limit
    { pool: U3_WETH_USDC_3000, zeroForOne: true, amountIn: e18(100_000) },
  ]);

  const [r1, r2, r3, r4] = results;
  const f = (x: bigint) => (Number(x) / 1e18).toFixed(4);
  const f6 = (x: bigint) => (Number(x) / 1e6).toFixed(2);

  console.log(`1. 197.53 WETH->USDC f3000 : in ${f(r1.consumed)} out ${f6(r1.received)} USDC`);
  console.log(`2. 48.45 cbETH->WETH f100  : in ${f(r2.consumed)} out ${f(r2.received)} WETH  ${r2.consumed < r2.amountIn ? "(PARTIAL — band exhausted, honest cap)" : "(fully consumed)"}`);
  console.log(`3. 1 WETH->USDC f3000      : in ${f(r3.consumed)} out ${f6(r3.received)} USDC`);
  console.log(`4. 100k WETH->USDC f3000   : in ${f(r4.consumed)} out ${f6(r4.received)} USDC  ${r4.consumed < r4.amountIn ? "(partial)" : ""}`);

  // Spot from the small trade (fee + negligible impact at 1 WETH).
  const spotUsdPerWeth = Number(r3.received) / 1e6;
  const bigAvgPrice = Number(r4.received) / 1e6 / 100_000;
  const cbethAvgWeth = Number(r2.received) / 1e18 / 48.45;

  const checks: Array<[string, boolean, string]> = [
    [
      "1. matches flash-sim's executed exit (~$504.9K, ±1%)",
      Math.abs(Number(r1.received) / 1e6 - 504_907) / 504_907 < 0.01,
      `got $${f6(r1.received)}`,
    ],
    ["1. full input consumed", r1.consumed === r1.amountIn, `${f(r1.consumed)}/${f(r1.amountIn)}`],
    ["3. ~spot on small trade", spotUsdPerWeth > 2000 && spotUsdPerWeth < 3200, `$${spotUsdPerWeth.toFixed(2)}/WETH`],
    [
      "4. size reports honest worse-than-spot price",
      bigAvgPrice < spotUsdPerWeth,
      `$${bigAvgPrice.toFixed(0)} avg vs $${spotUsdPerWeth.toFixed(0)} spot`,
    ],
    [
      "2. cbETH venue reports brutal impact (avg < 60% of fair)",
      cbethAvgWeth < 0.6,
      `${cbethAvgWeth.toFixed(3)} WETH/cbETH (fair ~1.0)`,
    ],
  ];
  let fail = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} (${detail})`);
    if (!ok) fail++;
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
