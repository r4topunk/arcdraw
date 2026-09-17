# DoraHacks BUIDL submission: Arc Microgrants

Paste-ready fields. Before submitting, replace every `[PLACEHOLDER]` (see [CHECKLIST.md](CHECKLIST.md)).

## Name

ArcDraw

## One-liner

Verifiable, permissionless randomness for Arc: drand beacons checked onchain with BLS12-381 precompiles, with fulfillment bounties paid in USDC.

## Description (≤ 300 words)

Arc has no usable onchain randomness. `PREVRANDAO` is 0 and there is no VRF provider. Fair allocations, jury selection and random audits have no secure entropy.

ArcDraw is a small randomness coordinator for Arc mainnet:

- **Request.** A contract calls `requestRandomness`. The coordinator pins a future round of drand quicknet, the League of Entropy's public beacon, at least four rounds (9 to 12 seconds) ahead, so nobody can know the outcome when the request lands.
- **Fulfill.** Anyone can fulfill it. The coordinator verifies the BLS signature for that round **onchain**, using Arc's EIP-2537 BLS12-381 precompiles through randa-mu/bls-solidity (MIT). It then derives a per-request value and calls the consumer back with limited gas. A failing callback never blocks fulfillment, and a refund after the timeout can't reroll the result. No oracle key, owner or upgrades.
- **Bounties.** Relayers can earn an optional **USDC** bounty. They also pay gas in USDC, so costs are priced in dollars: about 0.006 USDC per fresh round at Arc's 20 gwei floor.

What Arc is used for:
- the EIP-2537 precompiles, for trustless BLS verification;
- USDC as gas plus the USDC ERC-20 (6 decimals, EIP-2612 permit), for bounties and the demo;
- sub-second deterministic finality, so randomness arrives about 3 seconds after the round with no reorg risk.

The repo ships:
- the coordinator and a consumer base contract, with 129 Foundry tests (120 unit/fuzz/invariant tests with real drand vectors, plus 9 read-only Arc mainnet fork tests);
- a TypeScript SDK (viem) that verifies beacons offchain;
- a permissionless relayer with JSON logs and a health endpoint;
- a website with a live beacon verified in the browser, a request inspector and a finance demo. **FairAllocation** runs a provably fair lottery for an oversubscribed USDC sale and refunds losers in full.

Experimental and unaudited, MIT licensed.

## Tech stack

- **Chain:** Arc mainnet (chain id 5042). USDC gas, USDC ERC-20 `0x3600…0000`, EIP-2537 BLS12-381 precompiles, CREATE2 deployer
- **Contracts:** Solidity 0.8.30 (Osaka EVM), Foundry, randa-mu/bls-solidity (MIT, vendored)
- **Randomness:** drand quicknet (League of Entropy), BLS12-381 G1 unchained signatures, RFC 9380
- **SDK and relayer:** TypeScript, viem, @noble/curves, Zod, vitest, Node 22+, Docker
- **Web:** Next.js 16 (static export), React 19, Tailwind v4, wagmi v3
- **Tooling:** pnpm workspaces, Biome

## Links

| Field | Value |
|---|---|
| Live demo (Arc mainnet) | `[LIVE_URL]` |
| Public repo | `[REPO_URL]` |
| Coordinator contract | `https://explorer.arc.io/address/[COORDINATOR_ADDRESS]` |
| FairAllocation contract | `https://explorer.arc.io/address/[FAIR_ALLOCATION_ADDRESS]` |
| Demo video | `[VIDEO_URL]` |
| GitHub / X / Farcaster | `[GITHUB_PROFILE]` / `[X_PROFILE]` / `[FARCASTER_PROFILE]` |

## Demo video script (2:00)

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Landing hero, then the live beacon card ticking | "Arc has no randomness: PREVRANDAO is zero and there's no VRF. ArcDraw fixes that with drand, the League of Entropy beacon, verified onchain on Arc. This card fetches the latest round and checks its BLS signature right in the browser." |
| 0:15–0:35 | "How it works" diagram, then the coordinator on explorer.arc.io with its verified source | "A contract requests randomness and gets pinned to a drand round a few seconds in the future. When that round is out, anyone can submit the signature. The coordinator checks it with Arc's BLS12-381 precompiles. No oracle key, no owner, no upgrades." |
| 0:35–1:00 | `/app/`: connect wallet, request with a 0.01 USDC bounty, sign, the request appears as Pending then Fulfilled within seconds; relayer JSON log in a terminal split | "I request with a one-cent USDC bounty. My relayer sees the request, waits for the round, verifies the beacon offchain and fulfills. It arrived a few seconds later, and the bounty and the gas were both paid in USDC." |
| 1:00–1:20 | `/r/?id=N` inspector: 3 green checks, tx links | "Anyone can audit any request. The signature is valid for that round, the stored value matches, and the delivered randomness can be recomputed. Every tx links to the Arc explorer." |
| 1:20–1:45 | `/allocation/`: sale with 3 slots and 5 subscribers, draw, winners marked, a loser claims a refund | "The demo is finance, not a casino. An oversubscribed USDC sale: five subscribers for three slots, each paying with one permit signature. The draw uses ArcDraw, winners are picked onchain from the seed, and losers get their full USDC back." |
| 1:45–2:00 | Gas table, then the README credits and the repo URL | "A fresh round costs about 0.006 USDC, and a reused round about a tenth of a cent. It's open source under MIT, built on drand and randa-mu's BLS library. Experimental, live on Arc mainnet today." |

Recording tips:
- Record at 1920×1080.
- Pre-fund the wallets and create the sale before recording, then cut the waits.
- Keep the relayer terminal visible during 0:35–1:00.

## Proof tx checklist

Every link must open on explorer.arc.io before you submit. Source: `deployments/arc-mainnet.json` → `proofs`.

- [ ] ArcDrawCoordinator deployed and source verified: `[DEPLOY_TX_COORDINATOR]`
- [ ] FairAllocation deployed and source verified: `[DEPLOY_TX_FAIR_ALLOCATION]`
- [ ] `requestRandomness` from an EOA: `[REQUEST_TX]`
- [ ] Fulfilled by the relayer, fresh round, BLS verified onchain (gas recorded): `[FULFILL_TX]`
- [ ] `fulfillBatch` with 2 requests on one round: `[FULFILL_BATCH_TX]`
- [ ] `refund` after the timeout: `[REFUND_TX]`
- [ ] Late fulfill of the refunded request: `[LATE_FULFILL_TX]`
- [ ] FairAllocation `draw`, with a USDC bounty: `[FA_DRAW_TX]`
- [ ] Fulfill with a successful FairAllocation callback (`callbackSuccess = true`): `[CALLBACK_TX]`
- [ ] FairAllocation `finalize`: `[FA_FINALIZE_TX]`
- [ ] FairAllocation `claimRefund` by a loser: `[FA_REFUND_TX]`
- [ ] Measured gas copied to the README: request `[GAS_REQUEST]`, fresh fulfill `[GAS_FULFILL_FRESH]`, verified-round fulfill `[GAS_FULFILL_VERIFIED]`
