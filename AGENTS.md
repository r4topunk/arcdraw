# AGENTS.md: ArcDraw

Instructions for AI agents and contributors working in this repo. Everything is in English.

## TL;DR

```bash
git submodule update --init --recursive   # forge-std
cd contracts && forge build && forge test  # contracts (Osaka EVM, EIP-2537)
pnpm install && pnpm -r build && pnpm -r test   # sdk, relayer, web (from Stage 2)
```

Source of truth: `docs/PRD.md` (scope) → `docs/SPEC.md` (behaviour) → `contracts/src/interfaces/*.sol` (ABI).
If code and spec disagree, fix the code or update the spec in the same commit, with the reason.

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry project. `src/` coordinator, consumer base, `demo/FairAllocation.sol` |
| `contracts/lib/bls-solidity/` | Vendored randa-mu BLS2 (MIT, pinned commit). **Do not edit** |
| `contracts/lib/forge-std/` | git submodule |
| `packages/sdk/` | `@arcdraw/sdk` (viem, noble) |
| `services/relayer/` | `@arcdraw/relayer` (Node, JSON logs) |
| `apps/web/` | Next.js site |
| `deployments/arc-mainnet.json` | Addresses, deploy blocks, proof txs, measured gas |

## Hard rules

1. **Never** send transactions to Arc mainnet or testnet, deploy, or broadcast. Fork tests are read-only.
2. **Never** generate, request, print or store private keys or seeds. Deploy uses `--account <foundry keystore>`. The relayer reads `RELAYER_PRIVATE_KEY` from env. `.env*` is gitignored except `.env.example`, which holds placeholders only.
3. Do not publish: no `git push`, `npm publish`, hosting deploys or repo creation. The owner does these.
4. USDC in contracts: **only** the ERC-20 at `0x3600000000000000000000000000000000000000`, **6 decimals**. Never use `msg.value` or native transfers, and never add `payable`.
5. Keep to the MVP in `docs/PRD.md` section 4. Anything else goes to Roadmap v2.
6. Credit drand / League of Entropy and randa-mu/bls-solidity wherever the verification is described.

## Conventions

- Solidity `^0.8.30`, `evm_version = "osaka"`, custom errors (no revert strings in our code), NatSpec on every external function, `forge fmt`.
- Tests: `test/<Contract>.t.sol`. Fuzz round math and allocation. Real drand vectors live in `test/spike/` or fixtures, never fetched at test time.
- Randomness derivation is `keccak256(abi.encode(drandRandomness, block.chainid, coordinator, requestId))`. The SDK must match byte for byte.
- TypeScript: ESM, strict, `bigint` for chain values, viem `arc`/`arcTestnet` from `viem/chains`, vitest. `eth_getLogs` ranges are ≤ 10,000 blocks.
- Logs (relayer): one JSON object per line with `ts, level, msg, service, runId, tickId, round, requestIds, txHash`.
- Commits: imperative subject, scoped (`contracts:`, `sdk:`, `relayer:`, `web:`, `docs:`). Agent commits end with the `Co-Authored-By` trailer.

## Definition of done (any change)

- `forge build && forge test` green. `pnpm -r build && pnpm -r test` green once the TS packages exist.
- Spec, interfaces and SDK ABI stay in sync.
- Gas-relevant changes: update the SPEC section 10 table.
