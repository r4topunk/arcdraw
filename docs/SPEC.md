# ArcDraw Technical Spec

> Stage 1. The interfaces in `contracts/src/interfaces/*.sol` are the compiled source of truth. This document defines what they must do.
> Feasibility spike: `contracts/test/spike/QuicknetVerify.t.sol` verifies real quicknet beacons with vendored BLS2 under Osaka: **213,915 gas** for a compressed-signature verify.

## 0. Constants

| Name | Value |
|---|---|
| Arc mainnet / testnet chainId | 5042 / 5042002 |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| drand quicknet chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Scheme | `bls-unchained-g1-rfc9380` |
| DST | `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` |
| Message for round r | `sha256(uint64_be(r))`, hashed to G1 |
| Public key (G2, 96 bytes compressed) | `83cf0f28...5ece45a` (see `packages/sdk/src/index.ts`) |
| GENESIS_TIME / PERIOD | 1692803367 / 3 s |
| MIN_ROUND_DELAY | 4 (was 2 before the pre-mainnet audit, finding L1) |
| MAX_ROUND_DELAY | 10,512,000 rounds (~1 year; caps `requestRandomnessAtRound`) |
| MAX_CALLBACK_GAS_LIMIT | 500,000 |
| REQUEST_TIMEOUT | 3600 s after the pinned round timestamp |
| drand randomness | `sha256(signature48)` (matches the drand API `randomness` field) |

## 1. Architecture

```
                 drand League of Entropy (quicknet, 3s)
                              |
               HTTP: api.drand.sh / api2 / cloudflare
                              |
   +--------------------------v---------------------------+
   | @arcdraw/relayer (anyone can run)                     |
   |  scan logs (cursor, 10k chunks) -> pending set        |
   |  wait roundTimestamp -> fetch beacon -> verify offchain|
   |  simulate -> fulfillBatch(round, sig, ids)            |
   +--------------------------+---------------------------+
                              | tx (USDC gas)
 +----------------------------v--------------------------------------+
 | Arc mainnet                                                        |
 |                                                                    |
 |  Consumer (FairAllocation) --requestRandomness--> ArcDrawCoordinator|
 |        ^                                      |  BLS2 (randa-mu)   |
 |        |                                      |  EIP-2537 0x0b-0x11|
 |        +---- rawFulfillRandomness(id, rand) --+  USDC 0x3600.. bounty
 +--------------------------------------------------------------------+
                              ^
   @arcdraw/sdk (viem) -------+------- apps/web (landing, docs, app, demo)
```

Repo layout:

```
contracts/            Foundry. src/ArcDrawCoordinator.sol, src/ArcDrawConsumer.sol,
                      src/demo/FairAllocation.sol, src/interfaces/, script/, test/
contracts/lib/bls-solidity  vendored randa-mu BLS2 (MIT, pinned commit)
packages/sdk          @arcdraw/sdk
services/relayer      @arcdraw/relayer
apps/web              Next.js site
deployments/          arc-mainnet.json (addresses + proof txs)
```

## 2. Round math (must match between Solidity and SDK)

```
currentRound(t)  = t < GENESIS ? 0 : (t - GENESIS) / PERIOD + 1
roundTimestamp(r)= GENESIS + (r - 1) * PERIOD
minRequestRound  = currentRound(block.timestamp) + MIN_ROUND_DELAY
```

Proof of the safety margin. Let `c = currentRound(t)`. Then `GENESIS + (c-1)*3 <= t < GENESIS + c*3`, so
`roundTimestamp(c+4) = GENESIS + (c+3)*3 > t + 9` and `<= t + 12`.
The pinned round is published **strictly more than three periods after** `block.timestamp`.
The formula depends only on `block.timestamp`, so several blocks sharing one timestamp get the same `minRequestRound`. This is harmless: the margin holds for each of them.
It stays unsafe only if Arc's `block.timestamp` lags wall clock by >= 9s. That is a documented assumption, and Stage 3 measures it.
Audit finding L1: with the original `+2` delay the margin was only 3 to 6 s, so a lag of about 2 s plus mempool exposure left little room; the delay was raised to 4 rounds, which adds 6 s of latency.

`roundTimestamp(r)` saturates at `type(uint64).max` for rounds past the uint64 time range (audit finding I1), so a huge
round passed to `roundTimestamp` or `verifyRound` can never wrap to a timestamp in the past.

## 3. ArcDrawCoordinator

Interface: `contracts/src/interfaces/IArcDrawCoordinator.sol` (compiled). Summary:

```solidity
function requestRandomness(uint32 callbackGasLimit, uint96 bounty) external returns (uint256 requestId, uint64 round);
function requestRandomnessAtRound(uint64 round, uint32 callbackGasLimit, uint96 bounty) external returns (uint256 requestId);
function verifyRound(uint64 round, bytes calldata signature) external returns (bytes32 drandRandomness);
function fulfill(uint256 requestId, bytes calldata signature) external;
function fulfillBatch(uint64 round, bytes calldata signature, uint256[] calldata requestIds) external;
function refund(uint256 requestId) external;
function refundedBounty(uint256 requestId) external view returns (uint96); // round 1 fix: survives late fulfill

function getRequest(uint256 requestId) external view returns (Request memory);
function roundRandomness(uint64 round) external view returns (bytes32);
function currentRound() external view returns (uint64);
function minRequestRound() external view returns (uint64);
function maxRequestRound() external view returns (uint64);   // currentRound() + MAX_ROUND_DELAY
function roundTimestamp(uint64 round) external view returns (uint64);
function expiresAt(uint256 requestId) external view returns (uint64);
function requestCount() external view returns (uint256);

event RandomnessRequested(uint256 indexed requestId, address indexed requester, uint64 indexed round, uint96 bounty, uint32 callbackGasLimit);
event RoundVerified(uint64 indexed round, bytes32 drandRandomness, bytes signature);
event RandomnessFulfilled(uint256 indexed requestId, uint64 indexed round, address indexed fulfiller, bytes32 randomness, uint96 bountyPaid, bool callbackSuccess);
event BountyRefunded(uint256 indexed requestId, address indexed requester, uint96 bounty);

error RoundTooSoon(uint64 round, uint64 minRound);
error RoundTooFar(uint64 round, uint64 maxRound);            // Stage 2: bounds round math, no uint64 overflow
error CallbackGasLimitTooHigh(uint32 callbackGasLimit, uint32 maxCallbackGasLimit);
error InvalidSignatureLength(uint256 length);
error InvalidSignature(uint64 round);
error RoundNotReached(uint64 round, uint64 roundTimestamp);
error RequestNotFulfillable(uint256 requestId, Status status);
error RequestRoundMismatch(uint256 requestId, uint64 expectedRound, uint64 givenRound);
error NotRefundable(uint256 requestId, Status status);
error NotExpired(uint256 requestId, uint64 expiresAt);
error InsufficientGasForCallback(uint256 gasLeft, uint256 gasRequired);
```

Constructor: `constructor(address usdc)`. No owner, no pause, no upgrade. The public key and DST are constants.

### 3.1 Semantics

**request**
1. Check `callbackGasLimit <= MAX_CALLBACK_GAS_LIMIT` and `minRequestRound() <= round <= maxRequestRound()` (the upper bound was added in Stage 2 so `roundTimestamp`/`expiresAt` can never overflow and bounties cannot be parked for decades).
2. `requestId = ++requestCount` (ids start at 1).
3. Store `Request{requester: msg.sender, round, callbackGasLimit, Pending, bounty, createdAt: block.timestamp, randomness: 0}`.
4. If `bounty > 0`, call `USDC.transferFrom(msg.sender, this, bounty)` (SafeERC20-style return check).
5. Emit `RandomnessRequested`.

A request for a round that is already verified is impossible, because the round is always in the future.

**verifyRound(round, sig)** (internal `_verify` shared by the fulfill paths)
1. If `roundRandomness[round] != 0`, return it.
2. Check `sig.length == 48`.
3. Check `round != 0 && block.timestamp >= roundTimestamp(round)`, else revert `RoundNotReached`. This is cheap sanity: a valid signature cannot exist earlier, but the check avoids wasting gas.
3b. **Canonical encoding** (Stage 2): compression flag set, infinity flag clear, `x < p`, else `InvalidSignature`. Without this, `x + p` would decode to the same point but a different `sha256(sig)`, letting a fulfiller grind the randomness. Covered by `test_realBeacon_nonCanonicalXPlusPRejected`.
4. `BLS2.verifySingle(g1UnmarshalCompressed(sig), PK, hashToPoint(DST, sha256(uint64be(round))))`. Revert `InvalidSignature` unless both booleans are true. Wrap the library's string reverts: the whole call reverts either way. Note: a well-formed but off-curve x makes the EIP-2537 precompile fail, which burns all gas forwarded to it; relayers must verify offchain first.
5. `roundRandomness[round] = sha256(sig)`. Emit `RoundVerified`.

**fulfill(requestId, sig)** (`nonReentrant`, transient storage lock)
1. `r = requests[id]`. Require `status in {Pending, Refunded}`, else `RequestNotFulfillable`.
2. `d = _verify(r.round, sig)`.
3. `rand = keccak256(abi.encode(d, block.chainid, address(this), requestId))`.
4. Effects: `status = Fulfilled`, `randomness = rand`, `bountyPaid = status was Pending ? bounty : 0`, `bounty = 0`.
5. Pay `bountyPaid` to `msg.sender` via `USDC.transfer`.
6. Callback, only if `callbackGasLimit > 0 && requester.code.length > 0`:
   - `required = callbackGasLimit + callbackGasLimit / 63 + 5_000`. Revert `InsufficientGasForCallback` if `gasleft() < required`. A fulfiller cannot starve the callback and still get paid.
   - Low-level `call(callbackGasLimit, requester, 0, rawFulfillRandomness(id, rand))` in assembly **with no returndata copy** (returndata-bomb safe). `callbackSuccess = result`.
7. Emit `RandomnessFulfilled`.

**fulfillBatch(round, sig, ids)**: verify once. For each id: if the status is not Pending/Refunded, `continue` (a racing relayer may have fulfilled it). If `r.round != round`, revert `RequestRoundMismatch`. Otherwise apply steps 3-4 (effects) to the id and add its bounty to a running sum. After the loop, pay the summed bounty in one transfer (step 5). Then run the callbacks and emit the events for the fulfilled ids in order (steps 6-7), with the gas check applied before each callback.

**refund(id)**: permissionless. Require `status == Pending`, else `NotRefundable`. Require `block.timestamp >= expiresAt(id)`, else `NotExpired`. Set `status = Refunded` and `bounty = 0`, record `refundedBounty[id] = bounty` (kept forever, so consumers can account for the refund even after a late fulfillment), transfer the bounty to `requester` and emit `BountyRefunded`.

### 3.2 State machine

```
            request                  fulfill (bounty -> fulfiller, callback)
  None ─────────────> Pending ───────────────────────────────────────────> Fulfilled (terminal)
                         │                                                      ^
                         │ refund (t >= roundTs + 1h; bounty -> requester)      │ fulfill (no bounty, callback)
                         v                                                      │
                      Refunded ─────────────────────────────────────────────────┘
```

Key invariant: **the randomness of a request is fixed at creation** (round, chainId, coordinator, requestId), and every request can reach `Fulfilled` as long as drand has published that round. Refund cannot cancel an unfavourable outcome, so withholding gives a requester no advantage.

### 3.3 Storage layout (gas)

```
slot A: requester(160) | round(64) | callbackGasLimit(32)
slot B: status(8) | bounty(96) | createdAt(64)
slot C: randomness(256)
mapping(uint64 => bytes32) roundRandomness
uint256 requestCount
```

## 4. ArcDrawConsumer

`contracts/src/ArcDrawConsumer.sol` (compiled): an immutable `coordinator`, `rawFulfillRandomness` gated to the coordinator, and `_fulfillRandomness(uint256,bytes32)` virtual.

**Consumer rules** (in the docs site and NatSpec):
1. Freeze every input that the random outcome is applied to **before** requesting.
2. Keep the callback cheap (store the seed and emit). Do heavy work in a permissionless follow-up call.
3. Map `requestId` to your own entity and ignore unknown ids.
4. Never offer a "redraw on refund" path. Late fulfillment is always possible.
5. If using a bounty, `approve` the coordinator for `bounty` first.

## 5. FairAllocation (demo consumer)

Scenario: a USDC allocation round (for example an RWA pre-sale or a capped vault) is oversubscribed. K slots at a fixed price go to N subscribers, and the winners are chosen as a uniform random K-subset.

```solidity
contract FairAllocation is ArcDrawConsumer {
    enum Phase { None, Open, Drawing, Drawn, Finalized, Cancelled }
    struct Sale {
        address creator; address treasury;
        uint96 pricePerSlot;      // USDC 6 dec
        uint32 slots;             // K
        uint64 subscribeDeadline;
        uint96 bounty;            // escrowed from creator for the fulfiller
        Phase phase;
        uint256 requestId; bytes32 seed;
    }
    uint32 public constant MAX_PARTICIPANTS = 1000;
    uint32 public constant CALLBACK_GAS = 60_000;
    uint64 public constant DRAW_TIMEOUT = 7 days;

    function createSale(address treasury, uint96 pricePerSlot, uint32 slots, uint64 subscribeDeadline, uint96 bounty) external returns (uint256 saleId);
    function subscribe(uint256 saleId) external;                                   // transferFrom price, 1 per address
    function subscribeWithPermit(uint256 saleId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external; // EIP-2612 v"2"
    function draw(uint256 saleId) external returns (uint256 requestId);          // permissionless, after deadline, N > K
    function finalize(uint256 saleId) external;                                   // permissionless; N <= K skips randomness
    function claimRefund(uint256 saleId) external;                                // losers after Finalized; everyone after Cancelled
    function withdrawTreasury(uint256 saleId) external;                           // pull treasuryOwed to sale.treasury
    function withdrawCreatorBounty(uint256 saleId) external;                      // pull creatorOwed (unused escrow) to creator
    function syncSeed(uint256 saleId) external;                                   // Drawing + request Fulfilled: copy stored randomness
    function cancelStuckDraw(uint256 saleId) external;                            // Drawing, unfulfilled DRAW_TIMEOUT after the round: Cancelled
    function setTreasury(uint256 saleId, address newTreasury) external;          // creator only, any phase (audit L2)
    function setCreatorPayee(uint256 saleId, address payee) external;            // creator only: bounty payouts go to payee (audit L2)
    function isWinner(uint256 saleId, address account) external view returns (bool);
    function participants(uint256 saleId) external view returns (address[] memory);
    // Stage 2 additions: getSale, participantCount, hasRefunded, saleOfRequest, bountyReclaimed,
    // reclaimBounty(saleId) (forwards `coordinator.refundedBounty(requestId)` to the creator), treasuryOwed, creatorOwed,
    // MAX_PARTICIPANTS, CALLBACK_GAS, DRAW_TIMEOUT.

    event SaleCreated(uint256 indexed saleId, address indexed creator, address treasury, uint96 pricePerSlot, uint32 slots, uint64 subscribeDeadline);
    event Subscribed(uint256 indexed saleId, address indexed account, uint32 index);
    event DrawRequested(uint256 indexed saleId, uint256 indexed requestId, uint64 round);
    event SeedReceived(uint256 indexed saleId, uint256 indexed requestId, bytes32 seed);
    event Finalized(uint256 indexed saleId, uint32 winners, uint256 raised);
    event Refunded(uint256 indexed saleId, address indexed account, uint96 amount);
    event BountyReclaimed(uint256 indexed saleId, address indexed creator, uint96 amount);

    error WrongPhase(uint256 saleId, Phase phase);
    error SubscriptionClosed(uint256 saleId);
    error SubscriptionStillOpen(uint256 saleId, uint64 deadline);
    error AlreadySubscribed(uint256 saleId, address account);
    error SaleFull(uint256 saleId);          // N == MAX_PARTICIPANTS
    error NotOversubscribed(uint256 saleId);
    error NotEligibleForRefund(uint256 saleId, address account);
    error InvalidSaleParams();                     // treasury 0, price 0, slots 0 or deadline not in the future
    error BountyNotReclaimable(uint256 saleId);
}
```

Winner selection in `finalize` (bounded by MAX_PARTICIPANTS, memory only):
```
idx = [0..N-1]
for i in 0..K-1:
    j = i + uint256(keccak256(seed, i)) % (N - i)
    swap(idx[i], idx[j]); setBit(winnerBitmap, idx[i])
```
The partial Fisher-Yates shuffle yields a uniform K-subset. Modulo bias is below 2^-240 for N <= 1000. The treasury is credited `K * price` (pulled with `withdrawTreasury`) and losers pull their refunds. Measured finalize gas: N=1000, K=100 = 314,708; worst case N=1000, K=999 = 1,058,331 (see docs/GAS.md).

Stage 2 details: with N <= K no draw happens, every subscriber wins and the bounty escrow is credited to the creator in `finalize`. The callback uses 34,038 gas with cold storage (budget 60,000). If ArcDraw refunds the draw bounty (expiry), anyone calls `reclaimBounty` to forward it to the creator, before or after a late fulfillment (it reads `refundedBounty`). A blocklisted loser cannot claim, but cannot block anyone else either.

Round 1 hardening (fund-safety):
- `finalize` never transfers. It records the outcome and credits `treasuryOwed` / `creatorOwed`; `withdrawTreasury` and `withdrawCreatorBounty` are permissionless pulls to the sale's recipients. A blocklisted treasury or creator therefore cannot block finalization or any loser refund.
- Audit finding L2: a treasury or creator blocklisted for good would still lock its own credit. The creator (a blocklisted address can still send transactions) redirects it with `setTreasury` or `setCreatorPayee` (used by `withdrawCreatorBounty` and `reclaimBounty`). Only the creator can call them, and subscriber refunds never depend on either address.
- `syncSeed` recovers a sale stuck in `Drawing` when the coordinator marked the request Fulfilled but the callback failed: it copies the stored randomness, so the outcome is identical and cannot be ground.
- `cancelStuckDraw` is the liveness escape hatch: if the request is still not Fulfilled `DRAW_TIMEOUT` (7 days) after its round timestamp, the sale becomes `Cancelled` and every subscriber pulls a full refund. Anyone can fulfill with drand's public signature during those 7 days, so a single party cannot force a cancellation.

## 6. SDK (`@arcdraw/sdk`)

Dependencies: `viem` (peer), `@noble/curves`, `@noble/hashes`. Chains come from `viem/chains` `arc` / `arcTestnet` (verified present in viem 2.56.6).

```ts
export const QUICKNET: { chainHash; publicKey; genesisTime: bigint; period: bigint; dst };
export function roundAt(unixSeconds: bigint): bigint;
export function roundTime(round: bigint): bigint;
export const arcDrawCoordinatorAbi: Abi; export const fairAllocationAbi: Abi;
export const deployments: Record<5042 | 5042002, { coordinator: Address; fairAllocation: Address; deployBlock: bigint }>;

export type Beacon = { round: bigint; signature: Hex; randomness: Hex };
export function fetchBeacon(round: bigint | "latest", opts?: { urls?: string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<Beacon>;
export function verifyBeacon(beacon: Beacon): boolean;   // noble bls12_381 G1 RFC9380 + sha256(sig) == randomness
export function deriveRandomness(a: { drandRandomness: Hex; chainId: number; coordinator: Address; requestId: bigint }): Hex;

export type ArcDrawRequest = { id: bigint; requester: Address; round: bigint; callbackGasLimit: number;
  status: "none" | "pending" | "refunded" | "fulfilled"; bounty: bigint; createdAt: bigint; randomness: Hex };

export function createArcDraw(cfg: { publicClient: PublicClient; walletClient?: WalletClient; coordinator?: Address }): {
  request(o?: { callbackGasLimit?: number; bounty?: bigint; round?: bigint }): Promise<{ requestId: bigint; round: bigint; hash: Hex }>; // auto-approves USDC when bounty > 0
  getRequest(id: bigint): Promise<ArcDrawRequest>;
  waitForRandomness(id: bigint, o?: { timeoutMs?: number; pollMs?: number }): Promise<{ randomness: Hex; round: bigint }>;
  fulfill(id: bigint, o?: { beacon?: Beacon }): Promise<Hex>;
  fulfillBatch(round: bigint, ids: bigint[], o?: { beacon?: Beacon }): Promise<Hex>;
  refund(id: bigint): Promise<Hex>;
  scanRequests(o: { fromBlock: bigint; toBlock?: bigint; chunkSize?: bigint }): AsyncGenerator<{ requestId: bigint; round: bigint; bounty: bigint; blockNumber: bigint }>; // <= 10_000 blocks per getLogs
};
```

Stage 3 implementation notes (`packages/sdk`): `createArcDraw` also exposes `getRequests(ids)` (unknown ids map to
`undefined`), `getRoundRandomness(round)`, `getBeacon(round)`, `simulateFulfillBatch(round, ids, { account })`
(eth_call + estimateGas only, used by the relayer dry-run) and `scanLogs(...)` (per-window `{ requested, fulfilled }`,
which `scanRequests` wraps). `fulfill`/`fulfillBatch` send an empty signature when the round is already verified.
`simulateFulfillBatch` takes optional `fees` so the simulation does not run with `tx.gasprice == 0`.
`worstCaseFulfillBatchGas({ freshRound, callbackGasLimits })`, `callbackGasReserve` and `gasCostUsdc` (in `gas.ts`) give
a simulation-independent gas bound for `fulfillBatch`: 80k base + 250k when the round is not verified + per id 40k +
`callbackGasLimit + callbackGasLimit/63 + 10k` when it has a callback. The constants are checked against real BLS
executions in `contracts/test/FulfillBatchGasLimit.t.sol`.
Chains are exported as `arcMainnet`/`arcTestnet` (viem's `arc` ships without RPC URLs). `deployments` is generated from
`deployments/*.json` and omits chains with no coordinator address. Errors: `ArcDrawError` subclasses with a `code`.

Tests (vitest): round math matches the Solidity vectors, `verifyBeacon` passes on rounds 1000000/1000001 and fails on a swapped round, `deriveRandomness` matches a forge-generated vector, and the scanner chunks correctly against a mocked transport.

## 7. Relayer (`@arcdraw/relayer`)

A single Node process with no DB. State lives in `RELAYER_STATE_FILE` (`{ lastScannedBlock, pending: {id: round} }`).

```
loop every RELAYER_POLL_MS:
  tickId = ulid()
  head = getBlockNumber()
  for chunk in [cursor+1 .. head] step 10_000: getLogs(RandomnessRequested, RandomnessFulfilled) -> update pending
  persist cursor
  due = pending where roundTime(round) <= now and bounty >= MIN_BOUNTY
  group due by round
  for round in groups:
     beacon = fetchBeacon(round) with fallback urls, retry/backoff; verifyBeacon or skip+error
     ids = filter getRequest(id).status in {pending, refunded}   (multicall)
     simulateContract(fulfillBatch) -> gas; abort if gasPrice > MAX_GAS_PRICE
     send; wait receipt (1 conf = final); drop ids from pending
```

- **Logs**: one JSON line per event, via `pino` or a hand-rolled logger. Fields: `ts, level, msg, service:"relayer", runId, tickId, round, requestIds, txHash, gasUsed, latencyMs (receipt ts - roundTime), err`. `runId` is generated at boot. Every line for a batch carries `tickId` and `round`, which are the correlation ids.
- **Signer**: `RELAYER_PRIVATE_KEY` from env (placeholder in `.env.example`) via `privateKeyToAccount`. The relayer never logs the key.
- **Failure handling**: a revert with `RequestNotFulfillable` means a race was lost, logged at info. A drand fetch failure gets exponential backoff up to 30s. The RPC error budget is 5 consecutive failures, then exit(1) so the supervisor restarts it.
- **Health**: `GET /healthz` returns `{lastTickAt, pending, lastScannedBlock}` (optional port).
- **Stage 3 implementation notes** (`services/relayer`): the state file also records `inflight` transactions (one record
  per tx hash with its round, ids, nonce and fees; audit finding L3 replaced the per-round record), so a restart checks
  the receipt before resubmitting and a stuck tx is replaced with its own nonce and ids. Dry-run (`RELAYER_DRY_RUN=true`) needs no key and stops after
  simulation. `RELAYER_MIN_BOUNTY` is a decimal USDC amount. "Due" is judged by the head block timestamp, not wall
  clock. Tick ids are 8 hex chars (`randomUUID`), not ULIDs. Full env table: `services/relayer/README.md`.
- **Metrics in logs**: `fulfilled_total`, `batch_size`, `latency_ms`, `gas_used`.
- **Pre-mainnet audit hardening**:
  - R1 (gas griefing loop): the gas limit is `max(estimate + buffer, worstCaseFulfillBatchGas)`, simulation carries the
    real fee fields, and a batch that reverts onchain is bisected (halves after 5 s); an id that reverts alone is
    quarantined with exponential backoff (30 s doubling, capped at 1 h) and dropped after 6 strikes. State:
    `quarantine: { id: { strikes, notBefore, maxGroup } }`.
  - R2 (unpriced work): a batch is sent only if its bounties cover `RELAYER_COST_MARGIN_PCT` (default 120) percent of its
    worst-case gas cost at the current gas price, and each paying id covers its own share. `RELAYER_SPONSORED_REQUESTERS`
    are relayed for free and `RELAYER_MAX_CALLBACK_GAS` caps the callback budget the relayer pays for.

## 8. Web (`apps/web`)

Next.js (App Router) + Tailwind + wagmi/viem with an injected wallet. The site can be exported statically, and all data is read client-side from the Arc RPC.

| Route | Content |
|---|---|
| `/` | Landing: problem (PREVRANDAO=0), how it works (3-step diagram), live stats (requests, fulfilled, last round), credit to drand/LoE and randa-mu |
| `/docs` | Quickstart (Solidity consumer in about 10 lines), SDK, relayer run guide, trust model, gas table |
| `/app` | Request randomness (bounty optional), request list, "fulfill it yourself" button |
| `/r/[id]` | Inspect a request: status, round, round timestamp, drand signature, offchain verification badge, derived randomness recomputed in the browser, tx links |
| `/allocation` | FairAllocation demo: create sale, subscribe (permit), draw, finalize, winners/refunds |

## 9. Security and trust model

| Actor | Can | Cannot |
|---|---|---|
| drand LoE (>= threshold colluding) | Predict or bias rounds | - (the core trust assumption, documented) |
| Requester | Choose round >= min, choose callback gas | See the outcome before the request is final, or reroll via refund |
| Fulfiller / relayer | Delay (liveness), race for the bounty | Forge randomness (BLS verify), starve the callback gas (gasleft check), make the callback revert the fulfillment |
| Arc validators | Skew `block.timestamp` slightly | Change a verified beacon. If lag >= 9s the pinned round may already be public (assumption) |
| Consumer contract | Revert or loop in the callback, behave differently in simulation | Block the fulfillment or re-enter (nonReentrant, fixed gas), or drain the reference relayer in a revert loop (worst-case gas limit, bisection, quarantine) |
| Coordinator deployer | Nothing after deploy | Upgrade, pause, change key |

Checklist: CEI plus a transient reentrancy lock, no returndata copy on callback, only the ERC-20 6-decimal USDC interface, return-value checks on transfers, no native value handling (`payable` nowhere), no `selfdestruct`/`delegatecall`. Blocklisted requester or fulfiller: the bounty transfer reverts, so that party must use bounty 0. The vendored BLS library is unaudited, hence the **experimental** label.

## 10. Gas (measured in Stage 2; 20 gwei floor, 100k gas = 0.002 USDC)

Full table and method in `docs/GAS.md` (regenerate with `node contracts/script/gas-report.mjs`). Isolated transactions, real quicknet signatures:

| Call | Gas | USDC |
|---|---:|---:|
| `requestRandomness` no bounty | 94,208 | 0.0019 |
| `requestRandomness` with bounty | 119,731 | 0.0024 |
| `fulfill` fresh round, bounty, no callback | 313,443 | 0.0063 |
| `fulfill` fresh round, bounty, FairAllocation callback | 345,787 | 0.0069 |
| `fulfill` verified round | 75,845 | 0.0015 |
| `fulfillBatch` fresh round, 5 ids | 446,903 | 0.0089 |
| `refund`, bounty returned | 71,893 | 0.0014 |
| FairAllocation `finalize` N=1000, K=100 | 314,708 | 0.0063 |
| Deploy both contracts (CREATE2) | ~7.73M | ~0.155 |

Fresh-round `fulfill` is 313k, above the PRD's "<= 300k (+ callback)" target by ~4%: BLS verify (~214k) + canonical check + `RoundVerified` event carrying the 48-byte signature + cold request slots + USDC transfer. Accepting uncompressed signatures (v2) would save ~80k.

## 11. Test plan

**Foundry (unit, local Osaka EVM; EIP-2537 is in revm)**
- Spike (done): real quicknet vectors verify, wrong round fails, flipped flag fails.
- Round math: fuzz `currentRound`/`roundTimestamp` against the reference formula, `minRequestRound` margin `> t+9 && <= t+12`, `roundTimestamp` saturation, equal timestamps (`vm.warp` unchanged across requests).
- Request: too-soon round reverts, gas limit cap, bounty transferFrom (mock USDC 6 dec, `vm.etch` at 0x3600... in tests), ids increment, event fields.
- Verify: valid, wrong round, wrong length, flipped compression/sign bits, non-canonical x (x+p), infinity flag, before round timestamp, idempotent reuse without signature.
- Fulfill: bounty to fulfiller, derived randomness equals the formula, callback success/revert/out-of-gas/returndata bomb, insufficient gas reverts, reentrancy blocked, EOA requester no call.
- Batch: skip already fulfilled, mismatch reverts, a single bounty transfer.
- Refund: before expiry reverts, after expiry refunds, then fulfill still works with 0 bounty and the callback runs, double refund reverts.
- FairAllocation: full flow, N<=K without randomness, uniform distribution statistical test (fuzz seeds, chi-square-lite on 1000 runs), losers refund once, winners cannot refund, permit subscribe.
- Invariants: USDC balance of coordinator == sum of bounties of Pending requests. FairAllocation balance == unrefunded subscriptions until finalize.

**Fork (read-only, `--fork-url https://rpc.mainnet.arc.io`)**: deploy both contracts inside the fork (local, never broadcast) and fulfill with a live beacon fetched via ffi or a fixture. This confirms the Arc precompiles and USDC behave identically.

**SDK / relayer (vitest)**: the vectors from section 6, and a relayer tick against anvil `--hardfork osaka` with mocked drand HTTP.

## 12. Mainnet proof plan (Stage 3, owner-run)

1. Owner funds a keystore account with about 2 USDC on Arc mainnet. Agents never handle keys.
2. `cd contracts && forge script script/Deploy.s.sol --rpc-url arc_mainnet --account $FOUNDRY_ACCOUNT --broadcast` deploys ArcDrawCoordinator and FairAllocation through the CREATE2 deployer `0x4e59...956C` with salt `keccak256("arcdraw.v1")` (override `ARCDRAW_SALT`). Addresses are deterministic for a given bytecode, identical on testnet, and a rerun skips deployed contracts. Dry-run first without `--broadcast`.
3. Verify both on explorer.arc.io (`forge verify-contract --verifier blockscout --verifier-url https://explorer.arc.io/api/`; UNKNOWN until tried).
4. `node contracts/script/write-deployment.mjs --chain 5042` records addresses, deploy txs and blocks from `broadcast/Deploy.s.sol/5042/run-latest.json` into `deployments/arc-mainnet.json` (no RPC, no keys). Then `pnpm --filter @arcdraw/sdk abis:check`.
5. Start the relayer (dedicated key via env) and run the `cast` / web app steps in [DEPLOY.md](../DEPLOY.md) section 8:
   a. EOA request, bounty 0, and fulfill by the relayer (`requestTx`, `fulfillTx`)
   b. Consumer request with a 0.01 USDC bounty and the callback (`callbackTx`)
   c. 2 requests on the same round via `fulfillBatch` (reuse path)
   d. Request with the relayer paused, `refund` after 1h, then a late fulfill (`refundTx`)
   e. FairAllocation: sale K=3, 5 subscribers (owner wallets), draw, finalize, refunds (`fairAllocationDrawTx`)
6. Copy the tx links and measured gas into the README and the JSON. DoD: all links resolve on explorer.arc.io.

## 13. Implementation plan (~6-7 dev days)

| Day | Deliverable | DoD |
|---|---|---|
| 1 | Coordinator + consumer base | Unit tests for request/verify/fulfill/refund green |
| 2 | Batch, callback hardening, invariants, fork test | `forge test` green incl. fork |
| 3 | FairAllocation + tests + Deploy/Proof scripts | Distribution test green, dry-run script OK |
| 4 | SDK + vitest | Vectors match Solidity |
| 5 | Relayer + anvil e2e | e2e tick fulfills on anvil |
| 6 | Web (landing, docs, app, inspect, demo) | `pnpm build` green |
| 7 | Mainnet proof (owner) + README | Section 12 DoD |
