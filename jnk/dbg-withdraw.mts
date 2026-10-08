import { createPublicClient, http, parseAbi } from "viem";
import "dotenv/config";
const RPC = "https://base.drpc.org";
const OWNER = "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A";
const MORPHO = process.env.MORPHO_BLUE_ADDRESS!;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ORACLE = "0xdb45c254233d0ac0c2da371f384fbed63eb0698e";
const MARKET_ID = "0x51aaa099691db8140cc2610b45af4d42d4853bd66edc59a54546165d5d0e8777";
const PARAMS = [USDC, WETH, ORACLE, "0x0000000000000000000000000000000000000000", 860000000000000000n] as const;
const abi = parseAbi([
  "function withdraw((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function market(bytes32) view returns (uint256 totalSupplyAssets,uint256 totalSupplyShares,uint256 totalBorrowAssets,uint256 totalBorrowShares,uint48 lastUpdate,uint16 fee)",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint256 collateral,uint256 borrowShares)",
]);
const client = createPublicClient({ transport: http(RPC) });
const m = await client.readContract({ address: MORPHO, abi, functionName: "market", args: [MARKET_ID] });
console.log("market:", m);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
try {
  const p = await client.readContract({ address: ORACLE, abi: oracleAbi, functionName: "price" });
  console.log("oracle price:", p.toString());
} catch (e: any) { console.log("oracle price() revert:", e.shortMessage ?? e.message); }
try {
  await client.call({
    account: OWNER,
    address: MORPHO,
    abi,
    functionName: "withdraw",
    args: [PARAMS, 0n, 30000000000000n, OWNER, OWNER] as never,
  });
  console.log("static call OK");
} catch (e: any) {
  console.log("static call revert:", e.shortMessage ?? e.message);
  const data = e.data ?? e.cause?.data ?? e.raw;
  console.log("revert data:", data);
}

// revert reason at the failed block
try {
  await client.call({
    account: OWNER,
    address: MORPHO,
    abi,
    functionName: "withdraw",
    args: [PARAMS, 0n, 30000000000000n, OWNER, OWNER] as never,
    blockNumber: 52309903n,
  });
  console.log("block 52309903 call OK");
} catch (e: any) {
  console.log("block 52309903 revert:", e.shortMessage ?? e.message, "data=", e.data ?? e.cause?.data ?? "?");
}
