// Recover the 30 USDC supply claim from the OLD test market (no debt, no collateral)
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

const RPC = "https://base.drpc.org";
const OWNER = "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A";
const MORPHO = process.env.MORPHO_BLUE_ADDRESS!;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ORACLE = "0xdb45c254233d0ac0c2da371f384fbed63eb0698e";
const MARKET_ID = "0x51aaa099691db8140cc2610b45af4d42d4853bd66edc59a54546165d5d0e8777";
const PARAMS = [USDC, WETH, ORACLE, "0x0000000000000000000000000000000000000000", 860000000000000000n] as const;

const morphoAbi = parseAbi([
  "function withdraw((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint256 collateral,uint256 borrowShares)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const pkRaw = (process.env.PRIVATE_KEY ?? "").trim().replace(/^"|"$/g, "");
const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

const pos = (await publicClient.readContract({
  address: MORPHO,
  abi: morphoAbi,
  functionName: "position",
  args: [MARKET_ID, OWNER],
})) as [bigint, bigint, bigint];
const [supplyShares, collateral, borrowShares] = pos;
console.log(`position: shares=${supplyShares} coll=${collateral} borrowShares=${borrowShares}`);
if (supplyShares === 0n) {
  console.log("nothing to withdraw");
  process.exit(0);
}

const args = [PARAMS, 0n, supplyShares, OWNER, OWNER] as const;
const gas = await publicClient.estimateGas({
  account,
  address: MORPHO,
  abi: morphoAbi,
  functionName: "withdraw",
  args: args as never,
});
console.log(`gas estimate: ${gas}`);
const gasLimit = 250000n; // generous: exact-fit estimates keep OOG'ing on this node

const hash = await wallet.writeContract({
  address: MORPHO,
  abi: morphoAbi,
  functionName: "withdraw",
  args: args as never,
  gas: gasLimit,
});
console.log(`withdraw tx: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(`status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);

const [usdc, eth] = await Promise.all([
  publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [OWNER] }),
  publicClient.getBalance({ address: OWNER }),
]);
console.log(`wallet now: USDC ${formatUnits(usdc, 6)} / ETH ${formatUnits(eth, 18)}`);
