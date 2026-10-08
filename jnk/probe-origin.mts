// Probe: does eth_call.from propagate to tx.origin on our RPCs, and what does
// Morpho.liquidate actually return against the armed self-test market?
import "dotenv/config";
import { createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Hex } from "viem";
import { base } from "viem/chains";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const OW = "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A" as Address;
const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ORACLE = "0x79ba9768e2f2fb4921f1d6db3bb2699fd27c2800" as Address; // armed v2 oracle from the dry run
const LLTV = 860_000_000_000_000_000n;

const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const MORPHO_ABI = parseAbi([
  "function liquidate((address,address,address,address,uint256),address,uint256,uint256,address) returns (uint256,uint256)",
]);

const rpcs: Record<string, string> = {
  mainnetBase: "https://mainnet.base.org",
  publicnode: "https://base-rpc.publicnode.com",
  drpc: "https://base.drpc.org",
};

const params = [USDC, WETH, ORACLE, ZERO, LLTV] as const;

async function tryPrice(client: ReturnType<typeof createPublicClient>, from: Address | undefined, label: string) {
  try {
    const p = (await client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "price", account: from })) as bigint;
    console.log(`  ${label}: price = ${Number(p) / 1e24} (${p})`);
  } catch (e) {
    console.log(`  ${label}: ERROR ${String(e).slice(0, 160)}`);
  }
}

async function tryLiquidate(client: ReturnType<typeof createPublicClient>, from: Address, label: string) {
  const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: "liquidate", args: [params, OW, 1n, 0n, from] });
  try {
    const r = await client.request({ method: "eth_call", params: [{ from, to: MORPHO, data }, "latest"] });
    console.log(`  ${label}: RESULT ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e: any) {
    console.log(`  ${label}: REVERT ${JSON.stringify(e?.data ?? e?.cause?.data ?? String(e)).slice(0, 200)}`);
  }
}

(async () => {
  for (const [name, url] of Object.entries(rpcs)) {
    console.log(`\n── ${name} (${url})`);
    const client = createPublicClient({ chain: base, transport: http(url) });
    await tryPrice(client, OW, "oracle.price from OWNER");
    await tryPrice(client, STRANGER, "oracle.price from STRANGER");
    await tryPrice(client, undefined, "oracle.price from <none>");
    await tryLiquidate(client, OW, "liquidate from OWNER");
    await tryLiquidate(client, STRANGER, "liquidate from STRANGER");
  }
})();