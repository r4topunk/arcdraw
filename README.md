# ArcDraw

**Verifiable, permissionless randomness for [Arc](https://arc.io).**

Arc has `PREVRANDAO = 0` and no VRF provider, so contracts on Arc have no secure source of randomness. ArcDraw fills that gap:

1. A request pins a **future** [drand quicknet](https://drand.love) round.
2. Once the round is out, anyone can submit the League of Entropy BLS signature for it.
3. The coordinator checks that signature **onchain**, using Arc's EIP-2537 BLS12-381 precompiles.

Relayers are permissionless and can earn an optional USDC bounty.

> **Status: experimental, unaudited.** The BLS verification library has not been audited. Don't use ArcDraw to secure value you can't afford to lose.
> Mainnet addresses and proof txs are in [deployments/arc-mainnet.json](deployments/arc-mainnet.json) and [Mainnet proof](#mainnet-proof). If the addresses there are empty, it isn't deployed yet.

| | |
|---|---|
| Live site | `[LIVE_URL]` |
| Coordinator (Arc mainnet, chain id 5042) | `[COORDINATOR_ADDRESS]` on [explorer.arc.io](https://explorer.arc.io) |
| Docs | [Integration guide](apps/web/content/integration.md) · [PRD](docs/PRD.md) · [Spec](docs/SPEC.md) · [Gas](docs/GAS.md) · [FAQ](apps/web/content/faq.md) |
| Operators | [DEPLOY.md](DEPLOY.md) (mainnet runbook) · [CHECKLIST.md](CHECKLIST.md) (human-only steps) · [SUBMISSION.md](SUBMISSION.md) |

## Why Arc

| Arc property | What it means for ArcDraw |
|---|---|
| `PREVRANDAO = 0`, no VRF | Lotteries, jury selection and fair allocations have no native entropy on Arc. ArcDraw provides it |
| EIP-2537 BLS12-381 precompiles (0x0b-0x11) | Verifying a quicknet signature onchain takes about 214k gas. The coordinator trusts no oracle key: it checks the beacon itself |
| USDC is the gas token, 20 gwei floor | Costs are predictable in dollars: a fresh-round fulfill is about **0.006 USDC**. Bounties are paid in the same unit relayers spend on gas |
| Sub-second deterministic finality | Latency is roughly one drand period (3s) plus one block, and consumers never see a reorg |
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
| `requestRandomness(callbackGasLimit, bounty)` | Pins round `currentRound(block.timestamp) + 2`, which is at least 3s in the future. It stays correct when several blocks share a timestamp. An optional USDC bounty is escrowed | The outcome is unknowable when the request lands |
| `fulfill(id, sig)` / `fulfillBatch(round, sig, ids)` | Verifies the BLS signature once per round and stores `sha256(sig)`. Later requests on the same round skip the pairing (~76k gas). The fulfiller receives the bounty | A forged signature can't pass |
| Derivation | `randomness = keccak256(abi.encode(sha256(sig), chainid, coordinator, requestId))` | One value per request, independent across requests |
| Callback | `rawFulfillRandomness(id, randomness)` runs with exactly `callbackGasLimit` gas (max 500k) and its returndata is not copied | If the consumer reverts, fulfillment still goes through |
| `refund(id)` | After `roundTime + 1h`, the requester gets the bounty back. The request can still be fulfilled later, with the same value | A refund can't reroll the outcome |

## Repository

| Path | What |
|---|---|
| [`contracts/`](contracts) | Foundry, Osaka EVM. [`ArcDrawCoordinator`](contracts/src/ArcDrawCoordinator.sol) (no owner, no upgrade, no pause), [`ArcDrawConsumer`](contracts/src/ArcDrawConsumer.sol) (abstract base), [`FairAllocation`](contracts/src/demo/FairAllocation.sol) (demo), CREATE2 [deploy script](contracts/script/Deploy.s.sol) |
| [`packages/sdk`](packages/sdk/README.md) | `@arcdraw/sdk`: viem client (request, wait, fulfill, refund, windowed log scans), drand fetch plus offchain BLS verification (noble), round math and derivation that match the Solidity byte for byte, typed errors |
| [`services/relayer`](services/relayer/README.md) | `@arcdraw/relayer`: log cursor, one batch per round, retries and backoff, gas-price ceiling, dry-run mode, JSON logs with correlation ids, `/healthz`, Dockerfile |
| [`apps/web`](apps/web/README.md) | Next.js static site: landing page with a live beacon verified in the browser, docs, request app, per-request inspector, FairAllocation demo. Gets its ABIs, chain, drand helpers and round math from `@arcdraw/sdk` |
| [`deployments/`](deployments/arc-mainnet.json) | Addresses, deploy blocks, proof txs, measured gas |
| [`docs/`](docs) | PRD, spec, generated gas report |

## Quickstart

Requirements: Node >= 22, pnpm 11, Foundry (forge 1.x with Osaka support), git.

```bash
git clone --recurse-submodules [REPO_URL] arcdraw && cd arcdraw
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
| `requestRandomness`, no bounty | 94,192 | 0.0019 |
| `requestRandomness`, 0.01 USDC bounty | 119,715 | 0.0024 |
| `fulfill`, fresh round (BLS verify), bounty paid | 313,410 | 0.0063 |
| `fulfill`, round already verified | 75,845 | 0.0015 |
| `fulfill`, fresh round + FairAllocation callback | 345,721 | 0.0069 |
| `fulfillBatch`, fresh round, 5 requests | 446,892 | 0.0089 |
| `refund` | 49,659 | 0.0010 |

The BLS check alone costs 213,915 gas, and `verifyRound` used 235,588 execution gas on an Arc mainnet fork. Gas from real mainnet receipts: `[MAINNET_MEASURED_GAS]` (recorded in `deployments/arc-mainnet.json` after the proof run).

## Trust model

| Actor | Can | Cannot |
|---|---|---|
| drand League of Entropy (a threshold of members colluding) | Predict or bias rounds. **This is the core trust assumption** | n/a |
| Requester | Choose a round at least 2 ahead, and the callback gas | Learn the outcome before the request is final, or reroll it through a refund |
| Relayer / fulfiller | Delay fulfillment (liveness only), race for the bounty | Forge randomness (BLS verified onchain), starve the callback (`gasleft` check), make the callback revert fulfillment |
| Arc validators | Skew `block.timestamp` slightly | Change a verified beacon. Assumption: timestamp lag stays under 3s, otherwise the pinned round may already be public |
| Consumer contract | Revert or burn gas in its callback | Block fulfillment or re-enter (transient lock, fixed gas) |
| Deployer | Nothing after deployment | Upgrade, pause, change the drand key, take fees |

If no relayer shows up, anyone can fulfill later, including the requester from the web app, and the value stays the same. Always verify beacons offchain before sending: a malformed G1 point makes the precompile consume all forwarded gas (see [GAS.md](docs/GAS.md)). The full analysis is in [SPEC section 9](docs/SPEC.md#9-security-and-trust-model).

Known limitations:
- Only one beacon (quicknet) is supported.
- FairAllocation has no sybil resistance: it allows one slot per address.
- There is no hosted relayer SLA.

## Mainnet proof

The owner fills this in after running [DEPLOY.md](DEPLOY.md) section 7. Each hash links to explorer.arc.io.

| Scenario | Tx |
|---|---|
| Deploy ArcDrawCoordinator / FairAllocation | `[DEPLOY_TX_COORDINATOR]` / `[DEPLOY_TX_FAIR_ALLOCATION]` |
| EOA request, then fulfilled by the relayer | `[REQUEST_TX]` → `[FULFILL_TX]` |
| Two requests on one round, one `fulfillBatch` (reuse path) | `[FULFILL_BATCH_TX]` |
| Refund after the timeout, then a late fulfill | `[REFUND_TX]` → `[LATE_FULFILL_TX]` |
| FairAllocation: draw → fulfill with callback → finalize → loser refund | `[FA_DRAW_TX]` → `[CALLBACK_TX]` → `[FA_FINALIZE_TX]` → `[FA_REFUND_TX]` |

## Credits

- **[drand](https://drand.love) / League of Entropy**: the quicknet randomness beacon (chain hash `52db9ba7…e971`).
- **[randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity)** (MIT): BLS12-381 signature verification over the EIP-2537 precompiles. Vendored unmodified at a pinned commit in [`contracts/lib/bls-solidity`](contracts/lib/bls-solidity), with its [LICENSE](contracts/lib/bls-solidity/LICENSE).
- **[@noble/curves](https://github.com/paulmillr/noble-curves)** (MIT): offchain BLS verification in the SDK, the relayer and the browser.
- **[Arc](https://arc.io) by Circle**: the chain, USDC gas and the EIP-2537 precompiles.
- [Foundry](https://github.com/foundry-rs/foundry), [viem](https://viem.sh), [wagmi](https://wagmi.sh), [Next.js](https://nextjs.org).

## License

[MIT](LICENSE). The vendored `bls-solidity` keeps its own MIT license.
