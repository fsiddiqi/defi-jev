// One-off: exact wallet + test-market accounting (why the wallet dropped)
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import "dotenv/config";

const RPC = "https://base.drpc.org";
const OWNER = "0xb230D1B3D3B0efa8487db96c6593e84d6Ff3516A";
const MORPHO = process.env.MORPHO_BLUE_ADDRESS!;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
// OLD test market (v1 oracle) — funds stranded here
const MARKET = {
  loanToken: USDC,
  collateralToken: WETH,
  oracle: "0xdb45c254233d0ac0c2da371f384fbed63eb0698e",
  irm: "0x0000000000000000000000000000000000000000",
  lltv: 860000000000000000n,
} as const;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const morphoAbi = parseAbi([
  "function id((address,address,address,address,uint256)) pure returns (bytes32)",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint256 collateral,uint256 borrowShares)",
  "function market(bytes32) view returns (uint256 totalSupplyAssets,uint256 totalSupplyShares,uint256 totalBorrowAssets,uint256 totalBorrowShares,uint48 lastUpdate,uint16 fee)",
]);

const client = createPublicClient({ transport: http(RPC) });

const marketId = "0x51aaa099691db8140cc2610b45af4d42d4853bd66edc59a54546165d5d0e8777" as `0x${string}`;
const [eth, usdcBal, wethBal] = await Promise.all([
  client.getBalance({ address: OWNER }),
  client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [OWNER] }),
  client.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [OWNER] }),
]);

const p = await client.readContract({
  address: MORPHO,
  abi: morphoAbi,
  functionName: "position",
  args: [marketId, OWNER],
});
const mk = await client.readContract({
  address: MORPHO,
  abi: morphoAbi,
  functionName: "market",
  args: [marketId],
});

const [supplyShares, collateral, borrowShares] = p as [bigint, bigint, bigint];
const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = mk as [
  bigint, bigint, bigint, bigint,
];

const claimableSupply =
  totalSupplyShares === 0n ? 0n : (supplyShares * totalSupplyAssets) / totalSupplyShares;
const debt =
  totalBorrowShares === 0n ? 0n : -(-(borrowShares * totalBorrowAssets) / totalBorrowShares); // ceil div

console.log("=== wallet ===");
console.log(`  ETH   ${formatUnits(eth, 18)}`);
console.log(`  USDC  ${formatUnits(usdcBal, 6)}`);
console.log(`  WETH  ${formatUnits(wethBal, 18)}`);
console.log("=== old test market claim (recoverable) ===");
console.log(`  marketId          ${marketId}`);
console.log(`  supplyShares      ${supplyShares}`);
console.log(`  claimable USDC    ${formatUnits(claimableSupply, 6)}`);
console.log(`  collateral WETH   ${formatUnits(collateral, 18)}`);
console.log("=== old test market debt ===");
console.log(`  borrowShares      ${borrowShares}`);
console.log(`  debt USDC (ceil)  ${formatUnits(debt, 6)}`);
console.log(
  `  market totals: supply ${formatUnits(totalSupplyAssets, 6)} USDC / borrow ${formatUnits(totalBorrowAssets, 6)} USDC`,
);
