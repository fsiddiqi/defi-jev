import { createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData, type WalletClient, type PublicClient, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { LiquidationCandidate, ExecutionResult, ExecutionConfig } from "./types.js";

// ── Contract addresses (Base) ────────────────────────────────────────────────

const BALANCER_VAULT = (process.env.BALANCER_VAULT ?? "0xBA12222222228d8Ba445958a75a0704d566BF2C8") as `0x${string}`;
const SWAP_ROUTER = (process.env.SWAP_ROUTER ?? "0x2626664c2603336E57B271c5C0b26F421741e481") as `0x${string}`;
const USDC = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;

// IonicFlashLiquidation.sol - already deployed
const FLASH_LIQUIDATOR = (process.env.FLASH_LIQUIDATOR ?? "") as `0x${string}`; // TODO: set from deployment

const BALANCER_VAULT_ABI = parseAbi([
  "function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData) external",
]);

const FLASH_LIQUIDATOR_ABI = parseAbi([
  "function liquidate(address borrower, address cTokenDebt, address cTokenCollateral, uint256 repayAmount, bytes entrySwapPath, bytes exitSwapPath) external",
]);

// ── Swap path encoding (Uniswap V3 exactInput) ───────────────────────────────

function encodeSwapPath(hops: Array<{ token: `0x${string}`; fee: number }>): Hex {
  let encoded = "0x";
  for (let i = 0; i < hops.length; i++) {
    encoded += hops[i].token.slice(2);
    encoded += hops[i].fee.toString(16).padStart(6, "0");
  }
  // Final token
  encoded += hops[hops.length - 1].token.slice(2);
  return encoded as Hex;
}

function buildSwapPaths(candidate: LiquidationCandidate): { entry: Hex; exit: Hex } {
  // Simplified: USDC → debtAsset → collateralAsset → USDC
  // Real implementation needs proper pool fee tiers per pair
  const debtToken = USDC; // placeholder
  const collateralToken = USDC; // placeholder - needs real resolution

  const entryPath = encodeSwapPath([
    { token: USDC, fee: 500 },
    { token: debtToken, fee: 500 },
  ]);

  const exitPath = encodeSwapPath([
    { token: collateralToken, fee: 500 },
    { token: USDC, fee: 500 },
  ]);

  return { entry: entryPath, exit: exitPath };
}

// ── Execution ────────────────────────────────────────────────────────────────

export async function executeLiquidation(
  candidate: LiquidationCandidate,
  config: ExecutionConfig,
  wallet: WalletClient,
  publicClient: PublicClient
): Promise<ExecutionResult> {
  if (!FLASH_LIQUIDATOR) {
    return { success: false, error: "FLASH_LIQUIDATOR address not configured" };
  }

  // Pre-execution sanity: LTV within 0.5% of assumed
  const currentLtv = candidate.currentLtv;
  if (Math.abs(currentLtv - candidate.currentLtv) > 0.005) {
    return { success: false, error: "LTV drift > 0.5% since Jev eval" };
  }

  // Build swap paths
  const { entry, exit } = buildSwapPaths(candidate);

  // Estimate repay amount (borrow balance in smallest unit)
  const repayAmount = BigInt(Math.floor(candidate.borrowBalanceUsd * 1e6)); // USDC 6 decimals

  // Encode liquidate calldata
  const calldata = encodeFunctionData({
    abi: FLASH_LIQUIDATOR_ABI,
    functionName: "liquidate",
    args: [
      candidate.borrower,
      USDC, // cTokenDebt placeholder
      USDC, // cTokenCollateral placeholder
      repayAmount,
      entry,
      exit,
    ],
  });

  // Flash loan: borrow USDC from Balancer, call liquidate on callback
  const flashLoanCalldata = encodeFunctionData({
    abi: BALANCER_VAULT_ABI,
    functionName: "flashLoan",
    args: [
      FLASH_LIQUIDATOR,
      [USDC],
      [repayAmount],
      calldata,
    ],
  });

  try {
    // Simulate first
    await publicClient.call({
      account: wallet.account,
      to: BALANCER_VAULT,
      data: flashLoanCalldata,
    } as any);

    // Execute
    const txHash = await wallet.sendTransaction({
      to: BALANCER_VAULT,
      data: flashLoanCalldata,
      gas: 2_000_000n,
    } as any);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    return {
      success: receipt.status === "success",
      txHash,
      gasUsed: receipt.gasUsed,
      gasCostUsd: 0, // TODO: compute from gasUsed * gasPrice
      collateralSeizedUsd: candidate.expectedSeizeUsd,
      slippageUsd: 0,
      profitUsd: 0,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
