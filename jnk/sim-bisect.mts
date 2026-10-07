// bisect the flash-sim revert: which stage fails?
// Run: ./node_modules/.bin/tsx jnk/sim-bisect.mts
import "dotenv/config";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const SCRATCH = "0x1337133713371337133713371337133713371337" as const;
const CALLER = "0x1111111111111111111111111111111111111111" as const;
const artifact = JSON.parse(readFileSync("contracts/out/MorphoFlashLiquidator.json", "utf8")) as { abi: any; bytecode: Hex; deployedBytecode: Hex };

const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
const addrWord = (a: string) => word(BigInt(a));

async function raw(data: Hex, opts: { extra?: any[]; owner?: string; gas?: bigint } = {}) {
  try {
    const r: any = await client.call({
      account: CALLER,
      to: SCRATCH,
      data,
      gas: opts.gas,
      stateOverride: [
        {
          address: SCRATCH,
          code: artifact.deployedBytecode,
          stateDiff: [
            { slot: word(0n), value: addrWord(opts.owner ?? CALLER) },
            { slot: word(1n), value: addrWord(MORPHO) },
          ],
        },
        ...(opts.extra ?? []),
      ],
    });
    return { ok: r.data };
  } catch (e: any) {
    const data = e?.data ?? e?.cause?.data ?? e?.cause?.cause?.data;
    return { err: String(e?.shortMessage ?? e?.message).replace(/\n/g, " | ").slice(0, 300), data };
  }
}

async function main() {
  const { encodeFunctionData, decodeFunctionData, decodeFunctionResult, decodeErrorResult } = await import("viem");
  const abi = artifact.abi;

  // 1. view reads: does code + storage override apply?
  for (const fn of ["owner", "morpho"]) {
    const r = await raw(encodeFunctionData({ abi, functionName: fn } as any));
    console.log(`${fn}(): ${r.ok ? decodeFunctionResult({ abi, functionName: fn, data: r.ok as Hex }) : r.err}`);
  }

  const marketParams = {
    loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    collateralToken: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    oracle: "0x97FF9CbD7E77348b2B8FfBB883bF29452aD18295",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    lltv: 770000000000000000n,
  } as const;
  const borrower = "0x0461d1e394046f2351F42c600F07EdcBd69E8cED" as const;
  const repaidShares = 126935066657954653n;
  const realHops = [
    { pool: "0xA9DaFa443a02FBc907Cb0093276B3E6F4ef02A46", zeroForOne: true },
    { pool: "0x6c561B446416E1A00E8E93E221854d6eA4171372", zeroForOne: true },
  ];
  const enc = (hops: any[]) =>
    encodeFunctionData({ abi, functionName: "executeLiquidation", args: [marketParams, borrower, repaidShares, hops, 0n] } as any);

  const variants: [string, any, any[]][] = [
    ["wrong owner -> NotOwner", enc([]), { owner: "0x2222222222222222222222222222222222222222" }],
    ["healthy position, empty hops -> expect Morpho HealthyPosition", enc([]), {}],
    ["healthy position, real hops -> expect Morpho HealthyPosition", enc(realHops), {}],
    ["healthy position, real hops, gas=10M", enc(realHops), { gas: 10_000_000n }],
  ];

  for (const [label, data, opts] of variants) {
    const r = await raw(data, opts);
    if (r.ok) {
      console.log(`${label}: returned ${r.ok.slice(0, 74)}`);
      continue;
    }
    let detail = r.err;
    if (r.data && r.data !== "0x") {
      try {
        const dec = decodeErrorResult({
          abi: [...abi, { type: "error", name: "HEALTHY_POSITION", inputs: [] }] as any,
          data: r.data as Hex,
        });
        detail = `revert ${dec.errorName}(${dec.args?.join(",") ?? ""})`;
      } catch {
        detail = `revert data ${r.data.slice(0, 42)}`;
      }
    }
    console.log(`${label}: ${detail}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
