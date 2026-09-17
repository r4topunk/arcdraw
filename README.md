# ArcDraw

**Verifiable, permissionless randomness on [Arc](https://arc.io).** Arc has `PREVRANDAO = 0` and no VRF provider. ArcDraw pins a future [drand quicknet](https://drand.love) round for each request and verifies the League of Entropy BLS signature **onchain** through Arc's EIP-2537 BLS12-381 precompiles. Anyone can fulfill a request and earn an optional USDC bounty.

> Status: **experimental, Stage 1 (spec)**. Not audited. Not deployed yet.

- Product: [docs/PRD.md](docs/PRD.md)
- Technical spec: [docs/SPEC.md](docs/SPEC.md)
- Contributor/agent guide: [AGENTS.md](AGENTS.md)
- Deployments & mainnet proof txs: [deployments/arc-mainnet.json](deployments/arc-mainnet.json)

## How it works

1. A contract calls `requestRandomness(callbackGasLimit, bounty)`. The coordinator pins drand round `current + 2`, which is published more than 3s in the future.
2. When the round is out, any relayer calls `fulfill(requestId, signature)`. The coordinator verifies the BLS signature once per round (about 214k gas in the Stage 1 spike) and derives `keccak256(drandRandomness, chainId, coordinator, requestId)`.
3. The consumer receives `rawFulfillRandomness(requestId, randomness)`. A failing callback never blocks fulfillment, and refunds never allow a reroll.

## Quick start (dev)

```bash
git submodule update --init --recursive
cd contracts && forge build && forge test
```

## Credits

- [drand](https://drand.love) / League of Entropy: quicknet beacon
- [randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity) (MIT): BLS12-381 verification library, vendored in `contracts/lib/bls-solidity`

## License

MIT
