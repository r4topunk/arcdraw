# ArcDraw PRD

> Status: Stage 1 (PRD + SPEC). Owner: r4to. Date: 2026-09-17. License: MIT.
> Name check (2026-09-17): no "ArcDraw" in the arclenz.xyz Arc ecosystem list (213 entries) and no web result, so the working name stays.

## TL;DR

ArcDraw is a permissionless randomness coordinator for Arc. A contract asks for randomness and ArcDraw pins a **future drand quicknet round**. When that round comes out, **anyone** can submit the drand BLS signature. The contract **checks it onchain** with the EIP-2537 BLS12-381 precompiles, derives a per-request random value and calls the consumer back. The fulfiller can collect an optional USDC bounty.
There is no oracle operator to trust and no admin keys. The only trust assumption is the League of Entropy threshold.

## 1. Problem

- Arc has `PREVRANDAO = 0`, so apps have no onchain entropy at all.
- As of 2026-09-17, no VRF provider is live on Arc. That includes Chainlink VRF and Pyth Entropy (recheck on submission day).
- Commit-reveal needs every party online and is open to last-revealer bias. `blockhash` can be biased by proposers.
- Apps that need a fair, auditable draw are blocked or roll their own unsafe scheme: allocation lotteries, jury or committee selection, randomized audits, airdrop sampling.

## 2. Why Arc

| Arc property | Why it matters for ArcDraw |
|---|---|
| PREVRANDAO = 0, no VRF | Nobody else fills this primitive gap yet |
| EIP-2537 precompiles (0x0b-0x11) | drand quicknet signatures can be checked fully onchain (proved on mainnet, ~214k gas verify) |
| USDC as gas, 20 gwei floor | Predictable cost: about 0.0056 USDC to verify a fresh round. Bounties are paid in the same unit as gas |
| Sub-second deterministic finality | End-to-end latency is about the drand period (3s) plus 1 block. Consumers never see a reorg |
| Finance-first chain | Demo is a fair allocation for an oversubscribed USDC sale, not a casino |

## 3. Users

| User | Job to be done |
|---|---|
| Solidity dev on Arc | "Give me unbiased randomness with a callback, in 10 lines, without trusting an operator" |
| Relayer / keeper operator | "Earn USDC bounties by submitting public drand data" |
| End user of a consumer app | "Prove to me the draw was fair": link to request, round, signature and tx |
| Grant reviewer | See the request, fulfill and callback txs on Arc mainnet with published gas |

## 4. MVP scope (binding)

1. **ArcDrawCoordinator** (Solidity, immutable, no owner)
   - `requestRandomness` pins round `currentRound(block.timestamp) + 2`, with an optional USDC bounty.
   - `fulfill` / `fulfillBatch` verify the drand quicknet signature once per round and reuse it.
   - The per-request randomness is `keccak256(drandRandomness, chainId, coordinator, requestId)`.
   - The consumer callback is gas-limited. If it fails, the fulfillment still goes through.
   - `refund` returns the bounty after a timeout. The request remains fulfillable, so the outcome can never be rerolled.
2. **ArcDrawConsumer** abstract base contract.
3. **FairAllocation** demo consumer: an oversubscribed USDC sale with K slots and N > K subscribers. The winners are a uniformly random K-subset, losers get a full refund and the treasury receives K x price.
4. **@arcdraw/sdk** (TypeScript, viem): round math, drand fetch plus offchain verification, ABIs, request/fulfill/wait helpers and a chunked log scanner (the 10k-block `eth_getLogs` limit).
5. **@arcdraw/relayer**: a permissionless relayer that polls the drand HTTP API (with fallbacks), fulfills pending requests in per-round batches and writes structured JSON logs with correlation ids.
6. **apps/web**: landing page, docs, a live app to request and inspect randomness, and the FairAllocation demo.
7. **Mainnet proof**: verified deployments, plus request, fulfill (with callback), refund and allocation draw txs listed in the README and in `deployments/arc-mainnet.json`, with measured gas.

## 5. Non-goals (MVP)

- Casino or gambling UX, and token or NFT distribution in the demo
- Multiple beacons (evmnet, default chain), timelock encryption, or threshold networks other than drand quicknet
- Upgradeability, governance, fees or a protocol token
- Sybil resistance in FairAllocation (one slot per address, documented limitation)
- Hosted relayer SLA, a paymaster or gas sponsorship
- Subgraph or a dedicated indexer DB (the SDK scanner plus a JSON cursor is enough)
- npm publish and hosting (a manual owner action after Stage 3)

## 6. Success metrics

| Metric | Target (MVP) | Source |
|---|---|---|
| Mainnet proof txs | >= 1 each of request, fulfill+callback, fulfillBatch (reused round), refund, FairAllocation draw+finalize | explorer.arc.io links |
| Organic fulfilled requests | >= 20 during the review window | `RandomnessFulfilled` events |
| Fulfillment latency p50 | <= 6s after round timestamp | relayer logs |
| Fresh-round fulfill gas | <= 300k (+ callback) | receipts |
| Tests | `forge test` + SDK unit tests green; fuzz on round math and allocation | CI output |

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Chainlink/Randamu/Pyth launch VRF on Arc first | Novelty drops | Ship mainnet early. Stay permissionless and open, with no subscription |
| randa-mu/bls-solidity is unaudited | Forged randomness | Vendor at a pinned commit, add negative tests (wrong round, flipped flag bits, non-canonical x), label as **experimental** |
| drand quicknet retired or League of Entropy threshold compromised | Randomness predictable or unavailable | Document the trust model. v2 adds beacon-pluggable coordinators. Consumers can refund |
| `block.timestamp` lagging real time by >= 3s | Pinned round already public at request time | +2 round margin (>3s strictly). Document it. The relayer alerts when it sees a fulfillable round in the same block as the request |
| Relayer offline | Latency | Anyone can fulfill. The SDK exposes `fulfill`. The web app has a "fulfill it yourself" button |
| Callback gas griefing (63/64 rule) | Callback starved | Check `gasleft()` before the call and revert the whole fulfill if it is insufficient |
| USDC blocklist on requester/fulfiller | Refund/bounty transfer reverts | Documented. It does not affect randomness delivery when bounty = 0 |
| Consumer misuse (inputs mutable after request) | Biased app | Base contract docs, FairAllocation reference pattern, SPEC section "Consumer rules" |

## 8. Roadmap v2 (not in MVP)

- Uncompressed-signature fulfill path (~80k gas cheaper). The relayer decompresses offchain and the contract re-derives the canonical bytes.
- `requestRandomnessWithPermit` (EIP-2612) for one-tx EOA requests
- Jury/committee selection consumer (ERC-8183 job disputes) and weighted allocation
- Beacon registry: evmnet (BN254) and drand default chain
- Relayer incentives dashboard and multi-relayer race metrics
- Audit of the coordinator plus a pinned BLS library, then remove the "experimental" label

## UNKNOWN

- Whether Chainlink VRF or Pyth Entropy will be on Arc by submission day (recheck supported-networks pages)
- Arc validator `block.timestamp` drift bounds (not documented. Measure against wall clock during Stage 3)
- Contract verification flow on explorer.arc.io (viem lists a Blockscout-style `/api/v2`. Confirm `forge verify-contract --verifier blockscout` works)
- Hosting target for apps/web (owner decision)
