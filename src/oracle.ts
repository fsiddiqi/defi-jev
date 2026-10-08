import { createPublicClient, http, parseAbi, getAddress } from "viem";

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const ETH_USD_FEED = getAddress("0x71041dDdad3595F9CEd3dCCFBe3D1F4b0a16Bb70");

export async function checkOracleDivergence(
  client: ReturnType<typeof createPublicClient>,
  asset: string
): Promise<{ diverged: boolean; pctDiff: number; chainlinkPrice: number; pythPrice: number }> {
  return { diverged: false, pctDiff: 0, chainlinkPrice: 0, pythPrice: 0 };
}

export async function fetchEthPrice(client: ReturnType<typeof createPublicClient>): Promise<number> {
  const result = await client.readContract({
    address: ETH_USD_FEED,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
  }) as readonly [bigint, bigint, bigint, bigint, bigint];
  return Number(result[1]) / 1e8;
}
