// Does an Aerodrome-V2 pair expose its swap fee? (factory getters all revert)
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const c = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com") });
const VOLATILE = "0x8E5a94965005FF2eB41B69B9ADf41273f38d872a" as const; // USR/USDC
const STABLE = "0xd3eE0a3B349237D68517DF30bFB66Be971f46Ad9" as const;
for (const [pair, kind] of [[VOLATILE, "volatile"], [STABLE, "stable"]] as const) {
  for (const [label, abi, fn] of [
    ["swapFee()", parseAbi(["function swapFee() view returns (uint256)"]), "swapFee"],
    ["fee()", parseAbi(["function fee() view returns (uint256)"]), "fee"],
    ["stable()", parseAbi(["function stable() view returns (bool)"]), "stable"],
  ] as const) {
    try {
      const r = await c.readContract({ address: pair, abi, functionName: fn as never });
      console.log(`${kind} ${label} -> ${r}`);
    } catch (e: any) { console.log(`${kind} ${label} -> REVERT`); }
  }
}
