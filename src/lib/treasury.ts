// Where the money is, kept honest. Wallet + executor-contract balances for the
// tokens that can actually move value (native ETH, USDC, WETH). USD is 1:1 for
// USDC and ethPrice for ETH/WETH; anything else reports usd: null rather than
// inventing a price.
import { formatUnits, type Address, type PublicClient } from "viem";
import type { TokenHolding } from "../server.js";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface TreasuryToken {
  symbol: string;
  address: Address | null; // null = native ETH
  decimals: number;
}

export interface TreasuryDeps {
  publicClient: PublicClient;
  walletAddress: Address | null;
  contractAddress: Address | null;
  ethPriceUsd: number;
  tokens: TreasuryToken[];
}

/** Honest USD value: USDC pegged 1:1, ETH/WETH at the live ETH price, else null. */
export function usdValue(symbol: string, amount: number, ethPriceUsd: number): number | null {
  if (symbol === "USDC") return amount;
  if (symbol === "ETH" || symbol === "WETH") return amount * ethPriceUsd;
  return null;
}

async function readOne(
  deps: TreasuryDeps,
  account: Address,
  token: TreasuryToken,
): Promise<TokenHolding | null> {
  try {
    const raw =
      token.address === null
        ? await deps.publicClient.getBalance({ address: account })
        : await deps.publicClient.readContract({
            address: token.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [account],
          });
    const amount = Number(formatUnits(raw, token.decimals));
    return { symbol: token.symbol, amount, usd: usdValue(token.symbol, amount, deps.ethPriceUsd) };
  } catch {
    // A failed read must never invent a number — drop the holding from this
    // snapshot; the next cycle re-reads it.
    return null;
  }
}

export async function loadTreasury(deps: TreasuryDeps): Promise<{
  wallet: TokenHolding[];
  contract: TokenHolding[];
}> {
  const [wallet, contract] = await Promise.all([
    deps.walletAddress
      ? Promise.all(deps.tokens.map((t) => readOne(deps, deps.walletAddress!, t)))
      : Promise.resolve([]),
    deps.contractAddress
      ? Promise.all(deps.tokens.map((t) => readOne(deps, deps.contractAddress!, t)))
      : Promise.resolve([]),
  ]);
  return {
    wallet: wallet.filter((h): h is TokenHolding => h !== null),
    contract: contract.filter((h): h is TokenHolding => h !== null),
  };
}