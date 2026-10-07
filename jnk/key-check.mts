// Deployer key sanity: address + balances. Run from repo dir.
//   ./node_modules/.bin/tsx jnk/key-check.mts
import "dotenv/config";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const pk = (process.env.PRIVATE_KEY ?? "").trim();
if (!pk) { console.log("PRIVATE_KEY empty/missing"); process.exit(0); }
const acc = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
const c = createPublicClient({ chain: base, transport: http(process.env.QUOTE_RPC ?? "https://base-rpc.publicnode.com") });

const usdcAbi = [{ type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

const [eth, usdc] = await Promise.all([
  c.getBalance({ address: acc.address }),
  c.readContract({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi: usdcAbi, functionName: "balanceOf", args: [acc.address] }),
]);
console.log(`address: ${acc.address}`);
console.log(`ETH:     ${formatEther(eth)}  (gas money)`);
console.log(`USDC:    ${formatUnits(usdc, 6)}`);
