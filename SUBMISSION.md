# DoraHacks BUIDL submission: Arc Microgrants

Paste-ready fields for https://dorahacks.io/hackathon/arc-microgrants. Deadline: **2026-10-14 23:59 ET**.
Everything below is filled from Arc mainnet data (chain id 5042) checked on 2026-09-17. Lines starting with `TODO(owner):` still need the owner. Find them with `grep -n "TODO(owner)" SUBMISSION.md`.

## Name

ArcDraw

## One-liner

Verifiable, permissionless randomness for Arc: drand beacons checked onchain with BLS12-381 precompiles, with fulfillment bounties paid in USDC.

## Description (≤ 300 words)

Arc has no usable onchain randomness. `PREVRANDAO` is 0 and there is no VRF provider. Fair allocations, jury selection and random audits have no secure entropy.

ArcDraw is a small randomness coordinator, live on Arc mainnet:

- **Request.** A contract calls `requestRandomness`. The coordinator pins a future round of drand quicknet, the League of Entropy's public beacon, at least four rounds (9 to 12 seconds) ahead, so the outcome is unknown when the request lands.
- **Fulfill.** Anyone can fulfill it. The coordinator verifies the BLS signature for that round **onchain**, using Arc's EIP-2537 BLS12-381 precompiles through randa-mu/bls-solidity (MIT). It then derives a per-request value and calls the consumer back with limited gas. A failing callback never blocks fulfillment, and a refund after the timeout can't reroll the result. No oracle key, owner or upgrades.
- **Bounties.** Relayers can earn an optional **USDC** bounty. They also pay gas in USDC, so costs are priced in dollars: a fresh-round fulfill measured 292,424 gas (0.0058 USDC) on mainnet.

What Arc is used for:
- the EIP-2537 precompiles, for trustless BLS verification;
- USDC as gas plus the USDC ERC-20 (6 decimals, EIP-2612 permit), for bounties and the demo;
- sub-second deterministic finality, so randomness arrives about 3 seconds after the round with no reorg risk.

The repo ships:
- the coordinator and a consumer base contract, with Foundry unit, fuzz, invariant (real drand vectors) and read-only mainnet fork tests;
- a TypeScript SDK (viem) that verifies beacons offchain;
- a permissionless relayer with JSON logs and a health endpoint;
- a finance demo, **FairAllocation**: a provably fair lottery for an oversubscribed USDC sale that refunds losers in full.

Both contracts are deployed and Sourcify-verified (exact match) on Arc mainnet, with proof transactions for request, fulfill, batch fulfill and a full FairAllocation sale. Experimental and unaudited, MIT licensed.

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
| Live link (project page) | https://r4topunk.github.io/arcdraw/ |
| Public repo | https://github.com/r4topunk/arcdraw |
| ArcDrawCoordinator | https://explorer.arc.io/address/0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324 |
| FairAllocation | https://explorer.arc.io/address/0x536aA4934edc6a6d1502F504185B567ef6c53f89 |
| Source verification (Sourcify, exact match) | https://repo.sourcify.dev/5042/0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324 · https://repo.sourcify.dev/5042/0x536aA4934edc6a6d1502F504185B567ef6c53f89 |
| Demo video | TODO(owner): video URL (YouTube unlisted or Loom) |
| Hosted dApp (`apps/web`: request, inspector, allocation) | TODO(owner): hosted URL, or keep the project page as the live link |
| Builder profile (GitHub / X / Farcaster) | https://github.com/r4topunk · TODO(owner): X and/or Farcaster URL |

## Team

TODO(owner): builder name or pseudonym, role, one line of background. The program allows pseudonymous builders.

## Grant and next milestones

The microgrant is a fixed 500 USDC.

TODO(owner): confirm whether the form asks for use of funds or milestones. If it does, split the 500 USDC across the items below yourself; no amounts are proposed here.

Candidate milestones, taken from the repo docs:
1. Always-on hosted relayer with a public `/healthz` endpoint, funded through the review window.
2. Hosted dApp: request flow, request inspector and FairAllocation UI on Arc mainnet.
3. Publish `@arcdraw/sdk` to npm.

## Mainnet deployment

| Contract | Address | Deploy tx | Block | Verified |
|---|---|---|---|---|
| ArcDrawCoordinator | [0x3cfD…0324](https://explorer.arc.io/address/0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324) | [0xda30…b130](https://explorer.arc.io/tx/0xda3039bf510003cfd4297bfa0e53bca2d12cdca499c05c0c97623b3a573fb130) | 21338070 | Sourcify exact match |
| FairAllocation | [0x536a…3f89](https://explorer.arc.io/address/0x536aA4934edc6a6d1502F504185B567ef6c53f89) | [0xb139…2f7b](https://explorer.arc.io/tx/0xb1399e5697398eb6885b496e3bd054c7ff2fe35ffeb810fada14059a41662f7b) | 21338075 | Sourcify exact match |

Deployer: `0x39a7B6fa1597BB6657Fe84e64E3B836c37d6F75d`. Relayer: `0x8d60F8BB64b8e72dDdFCd24e90d50b60D68d1791`.
Blockscout verification on explorer.arc.io is blocked by a Cloudflare challenge on its API, so the contracts are verified on Sourcify instead.

## Mainnet proof transactions

All transactions below have status success. Gas and cost come from the mainnet receipts (gas price ≈ 20 gwei).

| # | Proof | Tx | Gas | Cost (USDC) |
|---|---|---|---|---|
| 1 | `requestRandomness` from an EOA | [0x9083…4e24](https://explorer.arc.io/tx/0x90833c5d63fd8dcc0d3d265dc3562efba7ad2eb5e26bd6621ee3480d417b4e24) | 94,208 | 0.0019 |
| 2 | Fulfill on a fresh round, BLS verified onchain | [0x6db4…5feb](https://explorer.arc.io/tx/0x6db4e6a1840cbe6ef4607e067cc1f183a7e7bfbad721f940a7286179a82a5feb) | 292,424 | 0.0058 |
| 3 | `fulfillBatch`: 2 requests, one round | [0x4fb4…bd5e](https://explorer.arc.io/tx/0x4fb45dc8d1aeafb32ba1edb5694c24028566f80b3f16570e0a3254d5a9eabd5e) | 326,596 | 0.0065 |
| 4 | Request with a 0.01 USDC bounty | [0x7bd5…2beb](https://explorer.arc.io/tx/0x7bd54a4279ca4ff9aa48cf8686bacf108369f82e6052273cbfa56dba527a2beb) | 106,774 | 0.0022 |
| 5 | Fulfill of #4 by the relayer; the 0.01 USDC bounty is paid to the fulfiller | [0x3da5…4778](https://explorer.arc.io/tx/0x3da592f61c4975e273d4bd8b9d9691017449d4eaae2001dc3fadc8e49b954778) | 320,633 | 0.0064 |
| 7 | FairAllocation `draw` (sale 1: 3 participants, 1 slot) | [0x524f…e5ab](https://explorer.arc.io/tx/0x524f6cc5f0ac2d4c442f7f53479004f613e408a10f4bb4f6bc71c030b987e5ab) | 172,205 | 0.0035 |
| 8 | Fulfill with the FairAllocation callback | [0x1d44…dc62](https://explorer.arc.io/tx/0x1d447ecb7e135bff0d14dc7722e172645df26a17892e05850354fe36155fdc62) | 357,814 | 0.0072 |
| 9 | FairAllocation `finalize` | [0xf2d0…a90d](https://explorer.arc.io/tx/0xf2d021ca69b5038c960dc60ee1101ddb33c53968cffb101ee61f632c5a75a90d) | 81,686 | 0.0017 |
| 10 | Loser refund 1 | [0x1a7f…2a5a](https://explorer.arc.io/tx/0x1a7f909aebb2f42a6835f58d5c9206f82d2c9359e9302348b2109f4b92002a5a) | 85,560 | 0.0017 |
| 11 | Loser refund 2 | [0xa05b…984c](https://explorer.arc.io/tx/0xa05b2d62136660cc7f993cc973d515aa639a6776b563fdc46e8856f405a1984c) | 68,460 | 0.0014 |
| 12 | Treasury withdraw | [0xa8d0…e0d4](https://explorer.arc.io/tx/0xa8d0bad3fea9949e789bbaa2de577bfe16c7dbc204039599e9969ead4370e0d4) | 54,130 | 0.0011 |

Measured gas: request 94,208; fulfill on a fresh round 292,424; batch of 2 on one round 326,596, so each extra request on an already verified round adds about 34k gas (about 0.0007 USDC). For comparison, a plain native USDC transfer is 21,000 gas.

## Demo video script (2:00)

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Project page hero, then the beacon card | "Arc has no randomness: PREVRANDAO is zero and there's no VRF. ArcDraw fixes that with drand, the League of Entropy beacon, verified onchain on Arc." |
| 0:15–0:35 | "How it works" diagram, then the coordinator on explorer.arc.io and its Sourcify exact match | "A contract requests randomness and gets pinned to a drand round a few seconds in the future. When that round is out, anyone can submit the signature. The coordinator checks it with Arc's BLS12-381 precompiles. No oracle key, no owner, no upgrades." |
| 0:35–1:00 | A request, then the relayer JSON log in a terminal, then the fulfill tx on the explorer | "I request randomness. My relayer sees the request, waits for the round, verifies the beacon offchain and fulfills. That fulfill cost about 0.006 USDC, paid in USDC." |
| 1:00–1:20 | Inspector (or the explorer logs of the fulfill): round, signature, delivered value | "Anyone can audit any request: the signature is valid for that round, and the delivered randomness can be recomputed. Every tx is on the Arc explorer." |
| 1:20–1:45 | FairAllocation sale 1 on the explorer: draw, callback, finalize, two loser refunds | "The demo is finance, not a casino. An oversubscribed USDC sale: three participants for one slot. The draw uses ArcDraw, the winner is picked onchain from the seed, and the losers get their full USDC back." |
| 1:45–2:00 | Gas table, then the README credits and the repo URL | "A fresh round costs about 0.006 USDC, and each extra request on the same round less than a tenth of a cent. MIT, built on drand and randa-mu's BLS library. Experimental, live on Arc mainnet." |

Recording tips: record at 1920×1080, cut the waits, keep the relayer terminal visible during 0:35–1:00.

## Before pasting

- [x] Both contracts deployed and Sourcify-verified (exact match)
- [x] Public repo and project page open (HTTP 200 on 2026-09-17)
- [x] Proofs #1–#4 and #7–#12 have status success on mainnet
- [x] proof #5 (bounty paid on fulfill). The refund-after-timeout path is covered by Foundry tests; it was not run on mainnet because the relayer fulfilled #4 first
- [ ] TODO(owner): demo video uploaded and linked
- [ ] TODO(owner): X/Farcaster profile and team line
- [x] the project page lists the contract addresses with explorer links (README has the full proof table)
- [ ] TODO(owner): relayer running through the review window (decisions by 2026-10-21), or state in the BUIDL that fulfillment is permissionless and the reference relayer is run on demand
