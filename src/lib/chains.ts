// Chain registry — the truth about where the bot looks vs where it can act.
//
// Every claim in this table is backed by docs/multichain-research.md (checked
// live 2026-10-07). The split matters:
//
//   SCANNED chains: the Morpho API (chainId_in) discovers liquidatable +
//   at-risk positions on all of them — the net is widened when idle.
//   EXECUTABLE chains: only chains with a deployed MorphoFlashLiquidator AND a
//   passed self-test gate (AUTO) can sign trades. Until a chain has both, its
//   candidates are discovery-only and are blocked BEFORE Jev with an honest
//   reason (no token burn on positions we can't act on).
//
// Tokens/venues are only listed when verified on-chain (✅ in the research doc);
// anything unverified is omitted and the code path honestly reports
// priceSource "none" / "no exit venue" instead of guessing.
import type { Address } from "viem";

export interface ChainVenues {
  /** label prefix for feed/dex rows, e.g. "aerodrome" */
  label: string;
  /** UniV3 factory: getPool(a, b, fee) — verified on this chain */
  v3Factory?: Address;
  /** Slipstream/CL-ish factory: getPool(a, b, tickSpacing) — verified */
  clFactory?: Address;
  /** Aero/Velodrome V2 factory: getPool(a, b, stable) — verified */
  v2Factory?: Address;
}

export interface ChainMeta {
  id: number;
  name: string;
  /** Morpho Blue singleton on this chain */
  morpho: Address;
  /** morpho address was re-verified on-chain (eth_getCode) this session */
  morphoVerified: boolean;
  /** read RPCs in preference order (all free tiers; publicnode pattern first) */
  rpc: string[];
  /** primary RPC endpoint responded this session (research doc) */
  rpcVerified: boolean;
  /** quote tokens for DEX discovery — verified addresses only */
  usdc?: Address;
  weth?: Address;
  /** DEX factories verified on this chain (none => priceSource "none") */
  venues?: ChainVenues;
}

export const CHAINS: Record<number, ChainMeta> = {
  1: {
    id: 1, name: "ethereum",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", morphoVerified: true,
    rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], rpcVerified: true,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    venues: {
      label: "univ3",
      v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
  },
  10: {
    id: 10, name: "optimism",
    morpho: "0xce95AfbB8EA029495c66020883F87aaE8864AF92", morphoVerified: true,
    rpc: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"], rpcVerified: true,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    weth: "0x4200000000000000000000000000000000000006",
    venues: {
      label: "univ3-velodrome",
      v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      // Velodrome V2 factory (verified address; CL factory liveness UNCERTAIN
      // per research — omitted so discovery never guesses).
      v2Factory: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a",
    },
  },
  8453: {
    id: 8453, name: "base",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", morphoVerified: true,
    rpc: ["https://base-rpc.publicnode.com", "https://base.drpc.org"], rpcVerified: true,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    venues: {
      label: "aerodrome",
      v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      clFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
      v2Factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    },
  },
  42161: {
    id: 42161, name: "arbitrum",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e", morphoVerified: true,
    rpc: ["https://arbitrum-rpc.publicnode.com"], rpcVerified: true,
    venues: {
      label: "univ3",
      v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
  },
  137: {
    id: 137, name: "polygon",
    morpho: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67", morphoVerified: false, // docs only, not re-verified on-chain
    rpc: ["https://polygon-rpc.publicnode.com"], rpcVerified: false,
    venues: {
      label: "univ3",
      v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
  },
  130: {
    id: 130, name: "unichain",
    morpho: "0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A", morphoVerified: false,
    rpc: ["https://unichain-rpc.publicnode.com"], rpcVerified: false,
    venues: {
      label: "univ3",
      v3Factory: "0x1F98400000000000000000000000000000000003",
    },
  },
  480: {
    id: 480, name: "world-chain",
    morpho: "0xE741BC7c34758b4caE05062794E8Ae24978AF432", morphoVerified: false,
    rpc: ["https://worldchain-rpc.publicnode.com"], rpcVerified: false,
    venues: {
      label: "univ3",
      v3Factory: "0x7a5028BDa40e7B173C278C5342087826455ea25a",
    },
  },
  // ── discovery-only chains (verified morpho address, unverified RPC) ─────────
  999: {
    id: 999, name: "hyperevm",
    morpho: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD", morphoVerified: false,
    rpc: ["https://hyperevm-rpc.publicnode.com"], rpcVerified: false,
  },
  143: {
    id: 143, name: "monad",
    morpho: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee", morphoVerified: false,
    rpc: ["https://monad-rpc.publicnode.com"], rpcVerified: false,
  },
  747474: {
    id: 747474, name: "katana",
    morpho: "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc", morphoVerified: false,
    rpc: ["https://katana-rpc.publicnode.com"], rpcVerified: false,
  },
  988: {
    id: 988, name: "stable",
    morpho: "0xa40103088A899514E3fe474cD3cc5bf811b1102e", morphoVerified: false,
    rpc: ["https://stable-rpc.publicnode.com"], rpcVerified: false,
  },
  4217: {
    id: 4217, name: "tempo",
    morpho: "0x10EE9AAC980A180dd4DcFc96C746d60B0EA88f97", morphoVerified: false,
    rpc: ["https://tempo-rpc.publicnode.com"], rpcVerified: false,
  },
  4663: {
    id: 4663, name: "robinhood",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010", morphoVerified: false,
    rpc: ["https://robinhood-rpc.publicnode.com"], rpcVerified: false,
  },
  5042: {
    id: 5042, name: "arc",
    morpho: "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD", morphoVerified: false,
    rpc: ["https://arc-rpc.publicnode.com"], rpcVerified: false,
  },
};

/** Chains the scanner discovers on (widens the net when idle). */
export const SCANNED_CHAIN_IDS: number[] = (process.env.SCAN_CHAIN_IDS ?? "1,8453,10,42161,137,130,480,999,143,747474,988,4217,4663,5042")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && CHAINS[n]);

/** Chains that can actually sign trades (deployed liquidator + passed gate). */
export const EXECUTABLE_CHAIN_IDS: Set<number> = new Set(
  (process.env.EXECUTABLE_CHAIN_IDS ?? "8453").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
);

export function isExecutableChain(id: number): boolean {
  return EXECUTABLE_CHAIN_IDS.has(id);
}