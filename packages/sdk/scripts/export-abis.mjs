#!/usr/bin/env node
// Regenerates packages/sdk/src/generated/abis.ts from Foundry artifacts.
// Usage: (cd contracts && forge build) && node packages/sdk/scripts/export-abis.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../contracts/out");
const target = resolve(here, "../src/generated/abis.ts");

const exportsList = [
  ["arcDrawCoordinatorAbi", "ArcDrawCoordinator.sol/ArcDrawCoordinator.json"],
  ["arcDrawConsumerAbi", "IArcDrawConsumer.sol/IArcDrawConsumer.json"],
  ["fairAllocationAbi", "FairAllocation.sol/FairAllocation.json"],
];

let src = "// GENERATED FILE, DO NOT EDIT. Regenerate: pnpm --filter @arcdraw/sdk abis\n";
src += "// Source: contracts/out (forge build). ABIs are `as const` for viem type inference.\n\n";
for (const [name, rel] of exportsList) {
  const file = resolve(out, rel);
  if (!existsSync(file)) {
    console.error(`missing artifact ${file}; run \`forge build\` in contracts/ first`);
    process.exit(1);
  }
  const { abi } = JSON.parse(readFileSync(file, "utf8"));
  src += `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n\n`;
}

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== src) {
    console.error("generated ABIs are stale: run pnpm --filter @arcdraw/sdk abis");
    process.exit(1);
  }
  console.log("ABIs up to date");
} else {
  writeFileSync(target, src);
  console.log(`wrote ${target}`);
}
