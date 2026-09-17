#!/usr/bin/env node
// Copies the ABIs the site needs from Foundry artifacts into src/generated/abis.ts.
// Usage: node scripts/sync-abis.mjs [--if-available]
//   --if-available: skip silently when contracts/out is missing (fresh clone without forge build);
//                   the committed src/generated/abis.ts is then used as is.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../contracts/out");
const target = resolve(here, "../src/generated/abis.ts");
const soft = process.argv.includes("--if-available");

const list = [
  ["arcDrawCoordinatorAbi", "ArcDrawCoordinator.sol/ArcDrawCoordinator.json"],
  ["fairAllocationAbi", "FairAllocation.sol/FairAllocation.json"],
];

let src = "// GENERATED FILE, DO NOT EDIT. Regenerate: pnpm --filter @arcdraw/web abis\n";
src += "// Source: contracts/out (forge build).\n\n";
for (const [name, rel] of list) {
  const file = resolve(out, rel);
  if (!existsSync(file)) {
    if (soft && existsSync(target)) {
      console.log(`[sync-abis] ${rel} not built; using committed src/generated/abis.ts`);
      process.exit(0);
    }
    console.error(`[sync-abis] missing ${file}; run forge build in contracts/ first`);
    process.exit(1);
  }
  const { abi } = JSON.parse(readFileSync(file, "utf8"));
  src += `export const ${name} = ${JSON.stringify(abi)} as const;\n\n`;
}
if (!existsSync(target) || readFileSync(target, "utf8") !== src) {
  writeFileSync(target, src);
  console.log(`[sync-abis] wrote ${target}`);
} else {
  console.log("[sync-abis] ABIs up to date");
}
