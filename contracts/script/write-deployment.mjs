#!/usr/bin/env node
// Records a Deploy.s.sol broadcast into deployments/<network>.json.
// Reads contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json (no RPC, no keys).
//
// Usage: node contracts/script/write-deployment.mjs --chain 5042 [--out deployments/arc-mainnet.json] [--broadcast <file>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);

const chainId = Number(args.chain ?? 5042);
const defaults = { 5042: "deployments/arc-mainnet.json", 5042002: "deployments/arc-testnet.json" };
const outPath = resolve(root, args.out ?? defaults[chainId] ?? `deployments/chain-${chainId}.json`);
const broadcastPath = resolve(
  root,
  args.broadcast ?? `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`,
);
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

if (!existsSync(broadcastPath)) {
  console.error(`broadcast file not found: ${broadcastPath}`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(broadcastPath, "utf8"));
if (Number(run.chain) !== chainId) {
  console.error(`broadcast chain ${run.chain} != --chain ${chainId}`);
  process.exit(1);
}

const ret = run.returns ?? {};
const addrOf = (name) => ret[name]?.value;
const contracts = {
  ArcDrawCoordinator: addrOf("coordinator"),
  FairAllocation: addrOf("fairAllocation"),
};
for (const [name, addr] of Object.entries(contracts)) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr ?? "")) {
    console.error(`missing return value for ${name} in ${broadcastPath}`);
    process.exit(1);
  }
}

// CREATE2 deploy txs go to the deployer; the first 32 calldata bytes are the salt, the address is in the receipt
// only indirectly, so match by order: Deploy.s.sol deploys the coordinator first, then FairAllocation.
const deployTxs = run.transactions.filter((t) => (t.transaction?.to ?? "").toLowerCase() === CREATE2_DEPLOYER);
const receipts = new Map((run.receipts ?? []).map((r) => [r.transactionHash, r]));

const base = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { chainId, contracts: {} };
base.chainId = chainId;
base.contracts ??= {};

const names = Object.keys(contracts);
// If a contract was already deployed the script skips it, so fewer txs than contracts can appear.
const skipped = names.length - deployTxs.length;
names.forEach((name, i) => {
  const prev = base.contracts[name] ?? {};
  const tx = deployTxs[i - skipped];
  const receipt = tx ? receipts.get(tx.hash) : undefined;
  const sameAddress = (prev.address ?? "").toLowerCase() === contracts[name].toLowerCase();
  base.contracts[name] = {
    ...prev,
    address: contracts[name],
    deployBlock: receipt ? Number(BigInt(receipt.blockNumber)) : sameAddress ? prev.deployBlock ?? null : null,
    deployTx: tx?.hash ?? (sameAddress ? prev.deployTx ?? "" : ""),
    verified: sameAddress ? prev.verified ?? false : false,
  };
});
if (run.returns) base.salt = process.env.ARCDRAW_SALT ?? base.salt ?? "keccak256(\"arcdraw.v1\")";

writeFileSync(outPath, JSON.stringify(base, null, 2) + "\n");
console.log(JSON.stringify({ level: "info", msg: "deployment recorded", chainId, out: outPath, contracts: base.contracts }));
