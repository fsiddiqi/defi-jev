import { createPublicClient, http, parseAbi } from "viem";
import "dotenv/config";
const client = createPublicClient({ transport: http("https://base.drpc.org") });
const txHash = "0x7dfe86ed6723722dbb7258bc4eb2c25a7414001adb69ec2bac147ec04d0f6d42";
const tx = await client.getTransaction({ hash: txHash });
console.log("gas:", tx.gas, "to:", tx.to, "input len:", tx.input.length);
console.log("input head:", tx.input.slice(0, 10));
const receipt = await client.getTransactionReceipt({ hash: txHash });
console.log("gasUsed:", receipt.gasUsed, "status:", receipt.status, "contractAddress:", receipt.contractAddress);
for (const l of receipt.logs) console.log("log:", l.address, l.topics[0]);
try {
  const res = await client.request({ method: "debug_traceTransaction" as never, params: [txHash, { disableMemory: true }] as never });
  console.log("trace:", JSON.stringify(res).slice(0, 2000));
} catch (e: any) { console.log("trace failed:", e.shortMessage ?? e.message); }
// replay as eth_call at that block with same gas
try {
  await client.call({ account: "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A", to: tx.to, data: tx.input, gas: tx.gas, blockNumber: receipt.blockNumber });
  console.log("replay OK");
} catch (e: any) { console.log("replay revert:", e.shortMessage ?? e.message, "data=", e.data ?? e.cause?.data ?? ""); }
