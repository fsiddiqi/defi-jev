import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com") });
const ABI = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const pools = [
  ["cbETH/WETH f100", "0xA9DaFa443a02FBc907Cb0093276B3E6F4ef02A46"],
  ["cbETH/WETH f500", "0x10648BA41B8565907Cfa1496765fA4D95390aa0d"],
  ["cbETH/WETH f3000", "0x7B9636266734270DE5bE02544c04E27046903ff8"],
  ["cbETH/USDC f3000", "0xa8E4C55D6dAf4D768aeBa2378c1AD94c112Ef48a"],
  ["WETH/USDC f3000", "0x6c561B446416E1A00E8E93E221854d6eA4171372"],
  ["WETH/USDC f500", "0xd0b53D9277642d899DF5C87A3966A349A798F224"],
] as const;
for (const [name, addr] of pools) {
  try {
    const [s0, liq, ts, fee] = await Promise.all([
      client.readContract({ address: addr as any, abi: ABI, functionName: "slot0" }),
      client.readContract({ address: addr as any, abi: ABI, functionName: "liquidity" }),
      client.readContract({ address: addr as any, abi: ABI, functionName: "tickSpacing" }),
      client.readContract({ address: addr as any, abi: ABI, functionName: "fee" }),
    ]);
    const price = (Number(s0[0]) / 2 ** 96) ** 2;
    console.log(`${name}: tick=${s0[1]} price(token1/token0)=${price} liquidity=${liq} tickSpacing=${ts} fee=${fee}`);
  } catch (e: any) { console.log(`${name}: ERR ${String(e.shortMessage ?? e).slice(0, 80)}`); }
}
