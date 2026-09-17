# ArcDraw

**Verifiable, permissionless randomness for [Arc](https://arc.io).**

Arc has `PREVRANDAO = 0` and no VRF provider, so contracts on Arc have no secure source of randomness. ArcDraw fills that gap:

1. A request pins a **future** [drand quicknet](https://drand.love) round.
2. Once the round is out, anyone can submit the League of Entropy BLS signature for it.
3. The coordinator checks that signature **onchain**, using Arc's EIP-2537 BLS12-381 precompiles.

Relayers are permissionless and can earn an optional USDC bounty.

> **Status: experimental, unaudited.** The BLS verification library has not been audited. Don't use ArcDraw to secure value you can't afford to lose.
> **Live on Arc mainnet** since 2026-09-17. Addresses and proof txs are in [deployments/arc-mainnet.json](deployments/arc-mainnet.json) and [Mainnet proof](#mainnet-proof). Source verified on [Sourcify](https://sourcify.dev) (exact match).

| | |
|---|---|
| Project page | https://r4topunk.github.io/arcdraw/ |
| Live site | https://r4topunk.github.io/arcdraw/ (project page; hosted app pending) |
| Coordinator (Arc mainnet, chain id 5042) | [`0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324`](https://explorer.arc.io/address/0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324) |
| FairAllocation demo | [`0x536aA4934edc6a6d1502F504185B567ef6c53f89`](https://explorer.arc.io/address/0x536aA4934edc6a6d1502F504185B567ef6c53f89) |
| Docs | [Integration guide](apps/web/content/integration.md) · [PRD](docs/PRD.md) · [Spec](docs/SPEC.md) · [Gas](docs/GAS.md) · [FAQ](apps/web/content/faq.md) |
| Operators | [DEPLOY.md](DEPLOY.md) (mainnet runbook) · [CHECKLIST.md](CHECKLIST.md) (human-only steps) · [SUBMISSION.md](SUBMISSION.md) |

## Why Arc

| Arc property | What it means for ArcDraw |
|---|---|
| `PREVRANDAO = 0`, no VRF | Lotteries, jury selection and fair allocations have no native entropy on Arc. ArcDraw provides it |
| EIP-2537 BLS12-381 precompiles (0x0b-0x11) | Verifying a quicknet signature onchain takes about 214k gas. The coordinator trusts no oracle key: it checks the beacon itself |
| USDC is the gas token, 20 gwei floor | Costs are predictable in dollars: a fresh-round fulfill is about **0.006 USDC**. Bounties are paid in the same unit relayers spend on gas |
| Sub-second deterministic finality | Latency is the 4-round safety delay (9-12s) plus one block, and consumers never see a reorg |
| USDC ERC-20 at `0x3600…0000` (6 decimals) with EIP-2612 permit | The FairAllocation demo takes subscriptions with a single permit signature and refunds losers in full |

## Architecture

```
          drand League of Entropy: quicknet, BLS12-381 G1, unchained, 3s period
                                     |
                    HTTP  api.drand.sh / api2.drand.sh / drand.cloudflare.com
                                     |
  +----------------------------------v----------------------------------+
  | @arcdraw/relayer  (permissionless, anyone can run one)              |
  |  scan logs with a cursor (<= 10k blocks per call) -> pending set    |
  |  round due? -> fetch beacon -> verify BLS offchain -> simulate      |
  |  -> fulfillBatch(round, signature, requestIds)                      |
  +----------------------------------+----------------------------------+
                                     | tx, gas paid in USDC
  +----------------------------------v----------------------------------+
  | Arc mainnet                                                         |
  |                                                                     |
  |  consumer (e.g. FairAllocation) --requestRandomness--> Coordinator  |
  |        ^                                                   |        |
  |        |                  randa-mu BLS2 over EIP-2537 precompiles   |
  |        +------ rawFulfillRandomness(id, randomness) -------+        |
  |                  (gas-limited; a failure never reverts)             |
  +---------------------------------------------------------------------+
        ^                                   ^
   @arcdraw/sdk (viem)            apps/web (landing, docs, live app, inspector, demo)
```

**Request lifecycle**

| Step | What happens | Guarantee |
|---|---|---|
| `requestRandomness(callbackGasLimit, bounty)` | Pins round `currentRound(block.timestamp) + 4`, which is published more than 9s after the request block. It stays correct when several blocks share a timestamp. An optional USDC bounty is escrowed | The outcome is unknowable when the request lands |
| `fulfill(id, sig)` / `fulfillBatch(round, sig, ids)` | Verifies the BLS signature once per round and stores `sha256(sig)`. Later requests on the same round skip the pairing (~76k gas). The fulfiller receives the bounty | A forged signature can't pass |
| Derivation | `randomness = keccak256(abi.encode(sha256(sig), chainid, coordinator, requestId))` | One value per request, independent across requests |
| Callback | `rawFulfillRandomness(id, randomness)` runs with exactly `callbackGasLimit` gas (max 500k) and its returndata is not copied | If the consumer reverts, fulfillment still goes through |
| `refund(id)` | After `roundTime + 1h`, the requester gets the bounty back. The request can still be fulfilled later, with the same value | A refund can't reroll the outcome |

## Repository

| Path | What |
|---|---|
| [`contracts/`](contracts) | Foundry, Osaka EVM. [`ArcDrawCoordinator`](contracts/src/ArcDrawCoordinator.sol) (no owner, no upgrade, no pause), [`ArcDrawConsumer`](contracts/src/ArcDrawConsumer.sol) (abstract base), [`FairAllocation`](contracts/src/demo/FairAllocation.sol) (demo), CREATE2 [deploy script](contracts/script/Deploy.s.sol) |
| [`packages/sdk`](packages/sdk/README.md) | `@arcdraw/sdk`: viem client (request, wait, fulfill, refund, windowed log scans), drand fetch plus offchain BLS verification (noble), round math and derivation that match the Solidity byte for byte, typed errors |
| [`services/relayer`](services/relayer/README.md) | `@arcdraw/relayer`: log cursor, batched fulfillment with a simulation-independent worst-case gas limit, bisection and quarantine after onchain reverts, bounty-covers-cost gate, retries and backoff, gas-price ceiling, dry-run mode, JSON logs with correlation ids, `/healthz`, Dockerfile |
| [`apps/web`](apps/web/README.md) | Next.js static site: landing page with a live beacon verified in the browser, docs, request app, per-request inspector, FairAllocation demo. Gets its ABIs, chain, drand helpers and round math from `@arcdraw/sdk` |
| [`deployments/`](deployments/arc-mainnet.json) | Addresses, deploy blocks, proof txs, measured gas |
| [`docs/`](docs) | PRD, spec, generated gas report |

## Quickstart

Requirements: Node >= 22, pnpm 11, Foundry (forge 1.x with Osaka support), git.

```bash
git clone --recurse-submodules https://github.com/r4topunk/arcdraw arcdraw && cd arcdraw
pnpm install

pnpm build        # forge build + sdk + relayer + static site (apps/web/out)
pnpm test         # forge tests, then vitest: sdk, relayer (the relayer e2e runs on a local anvil)
pnpm lint         # forge fmt --check + biome
pnpm typecheck
pnpm run verify   # all of the above plus the generated ABI/deployment drift checks
```

Note: use `pnpm run verify`. `pnpm ci` is a built-in pnpm command that reinstalls dependencies.

Other useful commands:

```bash
pnpm web:dev                                                        # http://localhost:3000
RELAYER_DRY_RUN=true COORDINATOR_ADDRESS=0x… pnpm relayer:dry-run   # read-only: simulates, never sends
cd contracts && ARC_FORK_TESTS=true forge test --match-path "test/fork/*" --threads 1   # read-only Arc mainnet fork
node contracts/script/gas-report.mjs                                # regenerate docs/GAS.md
```

### Use it from a contract

```solidity
import {ArcDrawConsumer} from "arcdraw/ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "arcdraw/interfaces/IArcDrawCoordinator.sol";

contract CommitteeDraw is ArcDrawConsumer {
    mapping(uint256 => bytes32) public seedOf;

    constructor(IArcDrawCoordinator c) ArcDrawConsumer(c) {}

    function draw() external returns (uint256 id) {
        (id,) = coordinator.requestRandomness(60_000, 0); // 60k callback gas, no bounty
    }

    function _fulfillRandomness(uint256 id, bytes32 randomness) internal override {
        seedOf[id] = randomness; // keep callbacks cheap; do heavy work in a separate call
    }
}
```

### Use it from TypeScript

```ts
import { arcMainnet, createArcDraw } from "@arcdraw/sdk";

const arcdraw = createArcDraw({ publicClient, walletClient, coordinator: "0x…" });
const { requestId } = await arcdraw.request({ bounty: 10_000n }); // 0.01 USDC (6 decimals)
const { randomness } = await arcdraw.waitForRandomness(requestId);
```

See the [SDK README](packages/sdk/README.md) for the full API and the [integration guide](apps/web/content/integration.md) for consumer rules.

## Gas and cost

Measured with isolated transactions and real quicknet signatures ([docs/GAS.md](docs/GAS.md)). Costs assume Arc's 20 gwei floor, paid in USDC.

| Call | Gas | USDC |
|---|---:|---:|
| `requestRandomness`, no bounty | 94,208 | 0.0019 |
| `requestRandomness`, 0.01 USDC bounty | 119,731 | 0.0024 |
| `fulfill`, fresh round (BLS verify), bounty paid | 313,443 | 0.0063 |
| `fulfill`, round already verified | 75,845 | 0.0015 |
| `fulfill`, fresh round + FairAllocation callback | 345,787 | 0.0069 |
| `fulfillBatch`, fresh round, 5 requests | 446,903 | 0.0089 |
| `refund`, bounty returned | 71,893 | 0.0014 |

The BLS check alone costs 213,915 gas, and `verifyRound` used 235,588 execution gas on an Arc mainnet fork. Gas from real mainnet receipts: `requestRandomness` 94,208 gas; first fulfill in a round 292,424 gas (0.0058 USDC); `fulfillBatch` for 2 requests on one round 326,596 gas (recorded in `deployments/arc-mainnet.json` after the proof run).

## Trust model

| Actor | Can | Cannot |
|---|---|---|
| drand League of Entropy (a threshold of members colluding) | Predict or bias rounds. **This is the core trust assumption** | n/a |
| Requester | Choose a round at least 4 ahead, and the callback gas | Learn the outcome before the request is final, or reroll it through a refund |
| Relayer / fulfiller | Delay fulfillment (liveness only), race for the bounty | Forge randomness (BLS verified onchain), starve the callback (`gasleft` check), make the callback revert fulfillment |
| Arc validators | Skew `block.timestamp` slightly | Change a verified beacon. Assumption: timestamp lag stays under 9s, otherwise the pinned round may already be public |
| Consumer contract | Revert or burn gas in its callback, or behave differently in simulation | Block fulfillment or re-enter (transient lock, fixed gas), or trap the reference relayer in a revert loop (worst-case gas limit, bisection, quarantine) |
| Deployer | Nothing after deployment | Upgrade, pause, change the drand key, take fees |

If no relayer shows up, anyone can fulfill later, including the requester from the web app, and the value stays the same. Always verify beacons offchain before sending: a malformed G1 point makes the precompile consume all forwarded gas (see [GAS.md](docs/GAS.md)). The full analysis is in [SPEC section 9](docs/SPEC.md#9-security-and-trust-model).

Known limitations:
- Only one beacon (quicknet) is supported.
- FairAllocation has no sybil resistance: it allows one slot per address.
- There is no hosted relayer SLA.

## Mainnet proof

Run on 2026-09-17 following [DEPLOY.md section 8](DEPLOY.md#8-on-chain-proof-scenario-spends). Each hash links to explorer.arc.io.

| Scenario | Tx |
|---|---|
| Deploy ArcDrawCoordinator / FairAllocation | [`0xda3039bf…`](https://explorer.arc.io/tx/0xda3039bf510003cfd4297bfa0e53bca2d12cdca499c05c0c97623b3a573fb130) / [`0xb1399e56…`](https://explorer.arc.io/tx/0xb1399e5697398eb6885b496e3bd054c7ff2fe35ffeb810fada14059a41662f7b) |
| EOA request, then fulfilled by the relayer | [`0x90833c5d…`](https://explorer.arc.io/tx/0x90833c5d63fd8dcc0d3d265dc3562efba7ad2eb5e26bd6621ee3480d417b4e24) → [`0x6db4e6a1…`](https://explorer.arc.io/tx/0x6db4e6a1840cbe6ef4607e067cc1f183a7e7bfbad721f940a7286179a82a5feb) |
| Two requests on one round, one `fulfillBatch` (reuse path) | [`0x4fb45dc8…`](https://explorer.arc.io/tx/0x4fb45dc8d1aeafb32ba1edb5694c24028566f80b3f16570e0a3254d5a9eabd5e) |
| Request with a 0.01 USDC bounty, fulfilled by the relayer (bounty paid) | [`0x7bd54a42…`](https://explorer.arc.io/tx/0x7bd54a4279ca4ff9aa48cf8686bacf108369f82e6052273cbfa56dba527a2beb) → [`0x3da592f6…`](https://explorer.arc.io/tx/0x3da592f61c4975e273d4bd8b9d9691017449d4eaae2001dc3fadc8e49b954778) |
| FairAllocation: draw → fulfill with callback → finalize → loser refund | [`0x524f6cc5…`](https://explorer.arc.io/tx/0x524f6cc5f0ac2d4c442f7f53479004f613e408a10f4bb4f6bc71c030b987e5ab) → [`0x1d447ecb…`](https://explorer.arc.io/tx/0x1d447ecb7e135bff0d14dc7722e172645df26a17892e05850354fe36155fdc62) → [`0xf2d021ca…`](https://explorer.arc.io/tx/0xf2d021ca69b5038c960dc60ee1101ddb33c53968cffb101ee61f632c5a75a90d) → [`0x1a7f909a…`](https://explorer.arc.io/tx/0x1a7f909aebb2f42a6835f58d5c9206f82d2c9359e9302348b2109f4b92002a5a) |

## Credits

- **[drand](https://drand.love) / League of Entropy**: the quicknet randomness beacon (chain hash `52db9ba7…e971`).
- **[randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity)** (MIT): BLS12-381 signature verification over the EIP-2537 precompiles. Vendored unmodified at a pinned commit in [`contracts/lib/bls-solidity`](contracts/lib/bls-solidity), with its [LICENSE](contracts/lib/bls-solidity/LICENSE).
- **[@noble/curves](https://github.com/paulmillr/noble-curves)** (MIT): offchain BLS verification in the SDK, the relayer and the browser.
- **[Arc](https://arc.io) by Circle**: the chain, USDC gas and the EIP-2537 precompiles.
- [Foundry](https://github.com/foundry-rs/foundry), [viem](https://viem.sh), [wagmi](https://wagmi.sh), [Next.js](https://nextjs.org).

## License

[MIT](LICENSE). The vendored `bls-solidity` keeps its own MIT license.
