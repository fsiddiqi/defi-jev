// Full error body for Morpho.liquidate eth_call on the armed market.
import "dotenv/config";
import { createPublicClient, http, parseAbi, encodeFunctionData, type Address } from "viem";
import { base } from "viem/chains";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const OW = "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ORACLE = "0x79ba9768e2f2fb4921f1d6db3bb2699fd27c2800" as Address;
const LLTV = 860_000_000_000_000_000n;

const MORPHO_ABI = parseAbi([
  "function liquidate((address,address,address,address,uint256),address,uint256,uint256,address) returns (uint256,uint256)",
]);

const params = [USDC, WETH, ORACLE, ZERO, LLTV] as const;
const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: "liquidate", args: [params, OW, 1n, 0n, OW] });

(async () => {
  for (const [name, url] of Object.entries({
    publicnode: "https://base-rpc.publicnode.com",
    drpc: "https://base.drpc.org",
  })) {
    const client = createPublicClient({ chain: base, transport: http(url) });
    try {
      const r = await client.request({ method: "eth_call", params: [{ from: OW, to: MORPHO, data }, "latest"] });
      console.log(`\n${name}: OK ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.log(`\n${name}: error keys=${Object.keys(e ?? {})}`);
      console.log(`  message: ${e?.message ?? e}`);
      const raw = e?.data?.data ?? e?.data;
      if (raw !== undefined) console.log(`  raw data: ${String(raw).slice(0, 300)} (len ${String(raw).length})`);
      const cause = e?.cause;
      if (cause) {
        console.log(`  cause keys=${Object.keys(cause)}`);
        console.log(`  cause.data=${JSON.stringify(cause).slice(0, 400)}`);
      }
      const body = e?.details ?? e?.body ?? e?.response?.body;
      if (body !== undefined) console.log(`  body: ${String(body).slice(0, 400)}`);
    }
  }
})();