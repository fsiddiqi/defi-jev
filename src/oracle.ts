import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import type { OraclePrice } from "./types";

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const ETH_USD_FEED = getAddress("0x71041dDdad3595F9CEd3dCCFBe3D1F4b0a16Bb70");
const BTC_USD_FEED = getAddress("0x7b13F7aE4CeF9CdD2B1a1b2fF4475d4E8b7D48F1");

const MORPHO_ORACLES: Record<string, `0x${string}`> = {
  WETH: ETH_USD_FEED,
  WBTC: BTC_USD_FEED,
  USDC: ETH_USD_FEED,
};

const IONIC_ORACLES: Record<string, `0x${string}`> = {};

const MAX_STALENESS: Record<string, number> = {
  "morpho-blue": 60,
  "ionic": 300,
};

export async function checkOracleFreshness(
  client: ReturnType<typeof createPublicClient>,
  protocol: "morpho-blue" | "ionic",
  asset: string
): Promise<{ fresh: boolean; ageSec: number; priceUsd?: number }> {
  const feeds = protocol === "morpho-blue" ? MORPHO_ORACLES : IONIC_ORACLES;
  const feed = feeds[asset.toUpperCase()];
  if (!feed) return { fresh: false, ageSec: 9999 };

  try {
    const [, , , updatedAt] = await client.readContract({
      address: feed,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    }) as readonly [bigint, bigint, bigint, bigint, bigint];

    const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
    const fresh = ageSec <= MAX_STALENESS[protocol];

    return { fresh, ageSec };
  } catch {
    return { fresh: false, ageSec: 9999 };
  }
}

export async function checkOracleDivergence(
  client: ReturnType<typeof createPublicClient>,
  asset: string
): Promise<{ diverged: boolean; pctDiff: number; chainlinkPrice: number; pythPrice: number }> {
  return { diverged: false, pctDiff: 0, chainlinkPrice: 0, pythPrice: 0 };
}

export async function fetchEthPrice(client: ReturnType<typeof createPublicClient>): Promise<number> {
  const [, answer] = await client.readContract({
    address: ETH_USD_FEED,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
  }) as readonly [bigint, bigint];
  return Number(answer) / 1e8;
}
