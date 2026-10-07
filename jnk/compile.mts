// Compile contracts/MorphoFlashLiquidator.sol with solc-js.
// Run: ./node_modules/.bin/tsx jnk/compile.mts
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = "MorphoFlashLiquidator.sol";
const source = readFileSync(join(root, "contracts", file), "utf8");

const input = {
  language: "Solidity",
  sources: { [file]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
const warnings = (out.errors ?? []).filter((e: any) => e.severity === "warning");
for (const w of warnings) console.log("warn:", w.formattedMessage.trim().split("\n")[0]);
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

const c = out.contracts[file]["MorphoFlashLiquidator"];
const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployedBytecode: "0x" + c.evm.deployedBytecode.object, solc: solc.version() };
mkdirSync(join(root, "contracts", "out"), { recursive: true });
writeFileSync(join(root, "contracts", "out", "MorphoFlashLiquidator.json"), JSON.stringify(artifact, null, 2));
console.log(`compiled ${file} with ${artifact.solc} -> contracts/out/MorphoFlashLiquidator.json`);
console.log(`runtime bytecode: ${c.evm.deployedBytecode.object.length / 2} bytes, abi entries: ${c.abi.length}`);
