# ArcDraw

**Verifiable, permissionless randomness on [Arc](https://arc.io).** Arc has `PREVRANDAO = 0` and no VRF provider. ArcDraw pins a future [drand quicknet](https://drand.love) round for each request and verifies the League of Entropy BLS signature **onchain** through Arc's EIP-2537 BLS12-381 precompiles. Anyone can fulfill a request and earn an optional USDC bounty.

> Status: **experimental, Stage 2 (contracts + tests)**. Not audited. Not deployed yet.

- Product: [docs/PRD.md](docs/PRD.md)
- Technical spec: [docs/SPEC.md](docs/SPEC.md)
- Contributor/agent guide: [AGENTS.md](AGENTS.md)
- Deployments & mainnet proof txs: [deployments/arc-mainnet.json](deployments/arc-mainnet.json)

## How it works

1. A contract calls `requestRandomness(callbackGasLimit, bounty)`. The coordinator pins drand round `current + 2`, which is published more than 3s in the future.
2. When the round is out, any relayer calls `fulfill(requestId, signature)`. The coordinator verifies the BLS signature once per round (a fresh-round `fulfill` costs ~313k gas, about 0.006 USDC; see [docs/GAS.md](docs/GAS.md)) and derives `keccak256(drandRandomness, chainId, coordinator, requestId)`.
3. The consumer receives `rawFulfillRandomness(requestId, randomness)`. A failing callback never blocks fulfillment, and refunds never allow a reroll.

## Quick start (dev)

```bash
git submodule update --init --recursive
cd contracts && forge build && forge test
ARC_FORK_TESTS=true forge test --match-path 'test/fork/*' --threads 1   # optional, read-only Arc mainnet fork
```

## SDK and relayer

| Package | What |
|---|---|
| [`@arcdraw/sdk`](packages/sdk/README.md) | viem client: request, wait, fulfill, refund, scan logs; drand fetch + offchain BLS verification; `arcMainnet`/`arcTestnet` |
| [`@arcdraw/relayer`](services/relayer/README.md) | Permissionless fulfiller: log cursor, batch per round, retries, JSON logs with correlation ids, dry-run, `/healthz`, Dockerfile |

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint
pnpm test                                   # forge tests, then vitest (relayer e2e runs on a local anvil)
RELAYER_DRY_RUN=true COORDINATOR_ADDRESS=0x… pnpm relayer:dry-run   # read-only: simulates, never sends
```

## Contracts

| Contract | What |
|---|---|
| [`ArcDrawCoordinator`](contracts/src/ArcDrawCoordinator.sol) | Request, verify, fulfill (single/batch), refund. No owner, no upgrade |
| [`ArcDrawConsumer`](contracts/src/ArcDrawConsumer.sol) | Abstract base: inherit and implement `_fulfillRandomness` |
| [`FairAllocation`](contracts/src/demo/FairAllocation.sol) | Demo: fair lottery for an oversubscribed USDC allocation, losers refunded in full |

Deploy (owner, keystore signer only): `forge script script/Deploy.s.sol --rpc-url arc_mainnet --account <keystore> --broadcast`, then `node script/write-deployment.mjs --chain 5042`.

## Credits

- [drand](https://drand.love) / League of Entropy: quicknet beacon
- [randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity) (MIT): BLS12-381 verification library, vendored in `contracts/lib/bls-solidity`

## License

MIT
