// Deploy MorphoFlashLiquidator to Base. Idempotent: if the deterministic
// CREATE address already holds the exact runtime bytecode, it just reports it.
//
//   ./node_modules/.bin/tsx jnk/deploy.mts
import "dotenv/config";
import { createPublicClient, createWalletClient, http, getContractAddress, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const artifact = JSON.parse(readFileSync("contracts/out/MorphoFlashLiquidator.json", "utf8")) as {
  abi: unknown[]; bytecode: Hex; deployedBytecode: Hex;
};

const pk = (process.env.PRIVATE_KEY ?? "").trim();
if (!pk) throw new Error("PRIVATE_KEY missing in .env");
const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));

const RPC = process.env.DEPLOY_RPC ?? process.env.QUOTE_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

async function main() {
  const nonce = await client.getTransactionCount({ address: account.address });
  const predicted = getContractAddress({ from: account.address, nonce });
  const balance = await client.getBalance({ address: account.address });
  console.log(`deployer: ${account.address}`);
  console.log(`balance : ${formatEther(balance)} ETH`);
  console.log(`nonce   : ${nonce} → predicted address ${predicted}`);

  const existing = await client.getBytecode({ address: predicted });
  if (existing && existing.toLowerCase() === artifact.deployedBytecode.toLowerCase()) {
    console.log(`already deployed at ${predicted} (bytecode match) — nothing to do`);
    return;
  }

  const gasPrice = await client.getGasPrice();
  console.log(`gas price: ${Number(gasPrice) / 1e9} gwei — deploying…`);
  const morpho = (process.env.MORPHO_BLUE_ADDRESS ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb") as `0x${string}`;
  console.log(`args: morpho=${morpho} owner=${account.address}`);
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [morpho, account.address],
  });
  console.log(`tx: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`deploy reverted (tx ${hash})`);
  console.log(`DEPLOYED at ${receipt.contractAddress}`);
  console.log(`gas used: ${receipt.gasUsed}  block: ${receipt.blockNumber}`);
  const code = await client.getBytecode({ address: receipt.contractAddress! });
  console.log(`runtime bytecode match: ${code?.toLowerCase() === artifact.deployedBytecode.toLowerCase()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
