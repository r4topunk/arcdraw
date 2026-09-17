#!/usr/bin/env node
// Regenerates packages/sdk/src/generated/deployments.ts from deployments/*.json (no RPC, no keys).
// Usage: node packages/sdk/scripts/export-deployments.mjs [--check]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../../deployments");
const target = resolve(here, "../src/generated/deployments.ts");

const entries = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const json = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
  const c = json.contracts ?? {};
  const coordinator = c.ArcDrawCoordinator?.address || null;
  if (!coordinator) continue; // not deployed yet
  entries.push({
    chainId: json.chainId,
    network: json.network,
    coordinator,
    fairAllocation: c.FairAllocation?.address || null,
    deployBlock: c.ArcDrawCoordinator?.deployBlock ?? 0,
  });
}

let src = "// GENERATED FILE, DO NOT EDIT. Regenerate: pnpm --filter @arcdraw/sdk deployments\n";
src += "// Source: deployments/*.json. Chains without a deployed coordinator are omitted.\n\n";
src += 'import type { Address } from "viem";\n\n';
src +=
  "export type ArcDrawDeployment = {\n  chainId: number;\n  network: string;\n  coordinator: Address;\n  fairAllocation: Address | null;\n  deployBlock: bigint;\n};\n\n";
src += "export const deployments: Readonly<Record<number, ArcDrawDeployment>> = {\n";
for (const e of entries) {
  src += `  ${e.chainId}: {\n    chainId: ${e.chainId},\n    network: ${JSON.stringify(e.network)},\n    coordinator: ${JSON.stringify(e.coordinator)},\n    fairAllocation: ${JSON.stringify(e.fairAllocation)},\n    deployBlock: ${BigInt(e.deployBlock)}n,\n  },\n`;
}
src += "};\n";

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== src) {
    console.error("generated deployments are stale: run pnpm --filter @arcdraw/sdk deployments");
    process.exit(1);
  }
  console.log("deployments up to date");
} else {
  writeFileSync(target, src);
  console.log(`wrote ${target} (${entries.length} deployment(s))`);
}
