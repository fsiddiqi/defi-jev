// Compile contracts/MorphoFlashLiquidator.sol with solc-js.
// Run: ./node_modules/.bin/tsx jnk/compile.mts
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const files = readdirSync(contractsDir).filter((f) => f.endsWith(".sol"));

const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(contractsDir, f), "utf8") }])),
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

mkdirSync(join(contractsDir, "out"), { recursive: true });
for (const file of files) {
  for (const [name, c] of Object.entries<any>(out.contracts[file])) {
    if (!c.evm?.bytecode?.object) continue; // interfaces/abstracts — no artifact
    const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployedBytecode: "0x" + c.evm.deployedBytecode.object, solc: solc.version() };
    writeFileSync(join(contractsDir, "out", `${name}.json`), JSON.stringify(artifact, null, 2));
    console.log(`compiled ${file} -> contracts/out/${name}.json (runtime ${c.evm.deployedBytecode.object.length / 2} bytes, abi ${c.abi.length})`);
  }
}
