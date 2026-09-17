# Integration guide

> ArcDraw is **experimental and unaudited**. Read the [trust model](/docs/spec/#9-security-and-trust-model) before securing real value with it.

ArcDraw gives an Arc contract a random `bytes32` that nobody could know when the request was made. It is backed by the [drand](https://drand.love) quicknet beacon of the League of Entropy and verified onchain with [randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity).

| Item | Value |
|---|---|
| Network | Arc mainnet, chain id `5042`, RPC `https://rpc.mainnet.arc.io` |
| Coordinator | `deployments/arc-mainnet.json` (also shown in the [app](/app/)) |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| Beacon | drand quicknet, BLS12-381 G1, 3 s period |

## 1. Choose a pattern

| Pattern | When | Callback gas |
|---|---|---|
| **Callback consumer** | Your contract must react when the value lands (store a seed, flip a phase) | `callbackGasLimit > 0` (max 500,000) |
| **Pull** | An EOA, or a contract that reads `getRequest(id).randomness` later | `0` |

## 2. Write a callback consumer

Add the contracts to your Foundry project and inherit `ArcDrawConsumer`:

```bash
forge install <arcdraw-repo>
# remappings.txt
arcdraw/=lib/arcdraw/contracts/src/
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ArcDrawConsumer} from "arcdraw/ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "arcdraw/interfaces/IArcDrawCoordinator.sol";

contract CommitteeDraw is ArcDrawConsumer {
    mapping(uint256 requestId => bytes32) public seedOf;

    constructor(IArcDrawCoordinator coordinator_) ArcDrawConsumer(coordinator_) {}

    function draw() external returns (uint256 requestId) {
        (requestId,) = coordinator.requestRandomness(60_000, 0);
    }

    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal override {
        seedOf[requestId] = randomness;
    }
}
```

`rawFulfillRandomness` in the base contract already rejects any caller other than the coordinator.

### Consumer rules

1. **Freeze inputs before requesting.** Everything the random value is applied to (participant list, weights, prize) must be final when you call `requestRandomness`.
2. **Keep the callback cheap.** Store the seed and emit an event. Run the expensive part (shuffles, payouts) in a separate permissionless call, as `FairAllocation.finalize` does.
3. **Map request ids to your own entities** and ignore unknown ids.
4. **Never redraw on refund.** A refunded request can still be fulfilled, with the same outcome.
5. **Bounty?** `approve` the coordinator for the bounty amount (USDC, 6 decimals) before requesting.

## 3. Request

```solidity
function requestRandomness(uint32 callbackGasLimit, uint96 bounty)
    external returns (uint256 requestId, uint64 round);

function requestRandomnessAtRound(uint64 round, uint32 callbackGasLimit, uint96 bounty)
    external returns (uint256 requestId);
```

- `requestRandomness` pins `currentRound(block.timestamp) + 2`, which drand publishes 3 to 6 seconds later.
- `requestRandomnessAtRound` pins any round between `minRequestRound()` and `maxRequestRound()` (about a year ahead), for draws that must happen at a scheduled time.
- `bounty` is optional. With `0` you rely on voluntary relayers, or you fulfill yourself from the [app](/app/). A bounty of 0.01 USDC is `10_000` units.

From TypeScript with viem:

```ts
import { parseEventLogs } from "viem";
import { arcDrawCoordinatorAbi } from "./abis"; // ABI JSON from contracts/out or the SDK

const hash = await wallet.writeContract({
  address: COORDINATOR,
  abi: arcDrawCoordinatorAbi,
  functionName: "requestRandomness",
  args: [0, 0n],
});
const receipt = await client.waitForTransactionReceipt({ hash });
const [evt] = parseEventLogs({ abi: arcDrawCoordinatorAbi, logs: receipt.logs, eventName: "RandomnessRequested" });
console.log(evt.args.requestId, evt.args.round);
```

## 4. Fulfill

Anyone can fulfill once the round is out. The signature is exactly what the drand HTTP API returns:

```bash
curl https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
```

```solidity
function fulfill(uint256 requestId, bytes calldata signature) external;
function fulfillBatch(uint64 round, bytes calldata signature, uint256[] calldata requestIds) external;
```

- The first fulfill of a round verifies the BLS signature (about 313k gas). Later requests on the same round reuse the stored value (about 76k gas) and may pass an empty signature.
- **Verify the beacon offchain before sending.** A malformed point makes the EIP-2537 precompile burn all forwarded gas.
- Leave headroom for the callback: `fulfill` reverts with `InsufficientGasForCallback` if less than `callbackGasLimit + callbackGasLimit/63 + 5000` gas is left at that point.

The per-request value is:

```solidity
keccak256(abi.encode(drandRandomness, block.chainid, coordinator, requestId))
```

where `drandRandomness = sha256(signature)`, the same `randomness` field the drand API publishes. The [inspector](/r/) recomputes both in your browser.

## 5. Run a relayer

The `@arcdraw/relayer` service scans `RandomnessRequested` logs in 10,000-block chunks (the Arc `eth_getLogs` limit), waits for each round, fetches and verifies the beacon, and calls `fulfillBatch` once per round. It writes one JSON log line per event, with `runId`, `tickId` and `round` as correlation ids.

```bash
cp .env.example .env    # set RELAYER_PRIVATE_KEY for a dedicated low-balance wallet
pnpm install
pnpm --filter @arcdraw/relayer start
```

See `services/relayer/README.md` in the repository for all options.

## 6. Refunds and timeouts

If nobody fulfills within **1 hour after the round timestamp**, anyone can call `refund(requestId)` and the bounty goes back to the requester. The request stays fulfillable without a bounty and its callback still runs, so a refund can never change or cancel the outcome.

## 7. Errors

| Error | Meaning |
|---|---|
| `RoundTooSoon(round, minRound)` | The pinned round would be public too early |
| `RoundTooFar(round, maxRound)` | More than about a year ahead |
| `CallbackGasLimitTooHigh` | Above 500,000 |
| `RoundNotReached(round, ts)` | drand has not published that round yet |
| `InvalidSignature(round)` | Not the drand quicknet signature for that round |
| `RequestNotFulfillable(id, status)` | Already fulfilled (often a relayer race) or unknown id |
| `NotExpired(id, expiresAt)` | Refund requested before the timeout |
| `InsufficientGasForCallback` | Send more gas with `fulfill` |
