# @arcdraw/sdk

TypeScript SDK for **ArcDraw**, permissionless and verifiable randomness on [Arc](https://arc.io).
Arc has `PREVRANDAO = 0` and no VRF. ArcDraw pins a future [drand quicknet](https://drand.love) round for each
request and verifies the League of Entropy BLS signature onchain (EIP-2537 precompiles, via
[randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity), MIT).

> **Experimental.** The contracts and the vendored BLS library are not audited.

- ESM only, strict TypeScript, `bigint` for every chain value
- [viem](https://viem.sh) peer dependency; offchain BLS verification with [@noble/curves](https://github.com/paulmillr/noble-curves)
- Config validated with Zod; every thrown error is a typed `ArcDrawError` with a stable `code`

## Install

```bash
pnpm add @arcdraw/sdk viem
```

## TL;DR

```ts
import { arcMainnet, createArcDraw } from "@arcdraw/sdk";
import { createPublicClient, createWalletClient, custom, http } from "viem";

const publicClient = createPublicClient({ chain: arcMainnet, transport: http() });
const walletClient = createWalletClient({ chain: arcMainnet, transport: custom(window.ethereum) });
const [account] = await walletClient.requestAddresses();

const arcdraw = createArcDraw({
  publicClient,
  walletClient: createWalletClient({ account, chain: arcMainnet, transport: custom(window.ethereum) }),
  coordinator: "0x…", // optional once the mainnet deployment is recorded in deployments/arc-mainnet.json
});

const { requestId, round } = await arcdraw.request({ bounty: 10_000n }); // 0.01 USDC bounty (6 decimals)
const { randomness } = await arcdraw.waitForRandomness(requestId);
```

## Chains

| Export | chainId | RPC | Explorer |
|---|---|---|---|
| `arcMainnet` | 5042 | `https://rpc.mainnet.arc.io` | `https://explorer.arc.io` |
| `arcTestnet` | 5042002 | `https://rpc.testnet.arc.io` (+ viem defaults) | viem default |

Both extend viem's `arc` / `arcTestnet` definitions. Gas is USDC (18 decimals natively). The SDK only ever uses
the **USDC ERC-20 at `0x3600…0000` with 6 decimals** (`USDC_ADDRESS`, `USDC_DECIMALS`).

## Examples

### Read a request

```ts
const r = await arcdraw.getRequest(42n);
// { id, requester, round, callbackGasLimit, status: "pending" | "refunded" | "fulfilled", bounty, createdAt, randomness }
```

### Request randomness

```ts
// Default round: currentRound + 4 (published strictly more than 9 s after the request block).
await arcdraw.request();

// Contract consumer with a callback and a bounty. The SDK approves USDC first if the allowance is short.
await arcdraw.request({ callbackGasLimit: 100_000, bounty: 25_000n });

// Pin a specific future round (must be in [minRequestRound, maxRequestRound]).
import { minRequestRound } from "@arcdraw/sdk";
const now = BigInt(Math.floor(Date.now() / 1000));
await arcdraw.request({ round: minRequestRound(now) + 20n });
```

Consumer contracts inherit `ArcDrawConsumer` (see `contracts/src/ArcDrawConsumer.sol`) and implement
`_fulfillRandomness(uint256 requestId, bytes32 randomness)`.

### Size a fulfillment gas limit (relayers)

```ts
import { gasCostUsdc, worstCaseFulfillBatchGas } from "@arcdraw/sdk";
// Every callback is assumed to burn its full budget: never size the limit from eth_estimateGas alone,
// a consumer can be cheap in simulation and expensive onchain.
const gas = worstCaseFulfillBatchGas({ freshRound: true, callbackGasLimits: [0, 100_000] });
const costUsdc = gasCostUsdc(gas, await publicClient.getGasPrice()); // 6-decimal units, rounded up
```

### Verify a drand beacon offchain

```ts
import { fetchBeacon, verifyBeacon } from "@arcdraw/sdk";

const beacon = await fetchBeacon(1_000_000n);  // falls back across api.drand.sh, api2.drand.sh, drand.cloudflare.com
verifyBeacon(beacon);                           // true: BLS12-381 (RFC 9380) + sha256(signature) == randomness
```

`fetchBeacon` verifies by default and throws `InvalidBeaconError` for a forged beacon. It also enforces the
coordinator's canonical-encoding rule, so a beacon that passes here will not revert onchain with `InvalidSignature`.

### Recompute a request's randomness

```ts
import { deriveRandomness } from "@arcdraw/sdk";

const drandRandomness = await arcdraw.getRoundRandomness(r.round); // sha256(signature), stored once per round
const expected = deriveRandomness({
  drandRandomness: drandRandomness!,
  chainId: 5042,
  coordinator: arcdraw.coordinator,
  requestId: r.id,
}); // keccak256(abi.encode(drandRandomness, chainId, coordinator, requestId)), byte-identical to Solidity
```

### Fulfill it yourself (permissionless)

```ts
const hash = await arcdraw.fulfill(42n);                        // fetches + verifies the beacon, simulates, sends
await arcdraw.fulfillBatch(round, [42n, 43n]);                  // one BLS verification for many requests
const { gas } = await arcdraw.simulateFulfillBatch(round, [42n], { account: "0x…" }); // eth_call + estimateGas only
await arcdraw.refund(42n);                                       // after expiresAt: bounty back, request stays fulfillable
```

If the round was already verified onchain, the SDK sends an empty signature (the cheap ~76k gas path).

### Scan events (Arc limits `eth_getLogs` to 10,000 blocks)

```ts
for await (const chunk of arcdraw.scanLogs({ fromBlock: 21_000_000n })) {
  chunk.requested;   // RandomnessRequested, decoded
  chunk.fulfilled;   // RandomnessFulfilled, decoded
  saveCursor(chunk.toBlock);
}
for await (const req of arcdraw.scanRequests({ fromBlock, toBlock })) console.log(req.requestId, req.round);
```

### Round math

```ts
import { expiryTime, minRequestRound, roundAt, roundTime } from "@arcdraw/sdk";
roundAt(1695803364n);   // 1000000n, mirrors currentRound()
roundTime(1000000n);    // 1695803364n, mirrors roundTimestamp()
expiryTime(1000000n);   // roundTime + 3600, mirrors expiresAt()
```

## Errors

```ts
import { ArcDrawError, ContractRevertError } from "@arcdraw/sdk";

try {
  await arcdraw.refund(42n);
} catch (err) {
  if (err instanceof ContractRevertError && err.errorName === "NotExpired") { /* wait */ }
  else if (err instanceof ArcDrawError) console.error(err.code, err.details);
  else throw err;
}
```

| Class | `code` | When |
|---|---|---|
| `InvalidConfigError` | `INVALID_CONFIG` | Bad `createArcDraw` config or call arguments |
| `UnsupportedChainError` | `UNSUPPORTED_CHAIN` | No known deployment for the chain and no `coordinator` passed |
| `MissingWalletError` | `MISSING_WALLET` | A write method was called without a `walletClient` account |
| `DrandFetchError` | `DRAND_FETCH_FAILED` | No relay returned the round (includes rounds not yet published); `attempts` lists each failure |
| `InvalidBeaconError` | `INVALID_BEACON` | Beacon fails BLS / canonical encoding / sha256 checks |
| `RequestNotFoundError` | `REQUEST_NOT_FOUND` | Unknown request id |
| `TimeoutError` | `TIMEOUT` | `waitForRandomness` deadline passed |
| `ContractRevertError` | `CONTRACT_REVERT` | Coordinator reverted; `errorName` / `args` hold the decoded custom error |

## Exports

`createArcDraw`, `arcDrawConfigSchema`, `arcMainnet`, `arcTestnet`, `fetchBeacon`, `verifyBeacon`,
`assertValidBeacon`, `beaconInvalidReason`, `isCanonicalCompressedG1`, `deriveRandomness`, `roundAt`, `roundTime`,
`minRequestRound`, `expiryTime`, `QUICKNET`, `USDC_ADDRESS`, `COORDINATOR_LIMITS`, `MAX_LOG_RANGE`,
`arcDrawCoordinatorAbi`, `arcDrawConsumerAbi`, `fairAllocationAbi`, `deployments`, and the error classes.

## Development

```bash
pnpm --filter @arcdraw/sdk build        # tsc -> dist/
pnpm --filter @arcdraw/sdk test         # vitest: round math, real quicknet vectors, derivation parity, mocked-transport client
pnpm --filter @arcdraw/sdk typecheck
pnpm --filter @arcdraw/sdk lint         # biome
pnpm --filter @arcdraw/sdk abis         # regenerate ABIs from contracts/out (abis:check in CI)
pnpm --filter @arcdraw/sdk deployments  # regenerate src/generated/deployments.ts from deployments/*.json
```

Test vectors are the same real beacons as `contracts/test/fixtures/Quicknet.sol`; nothing is fetched at test time.

## Credits

- [drand](https://drand.love) / League of Entropy for the quicknet beacon
- [randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity) (MIT) for onchain BLS12-381 verification
- [@noble/curves](https://github.com/paulmillr/noble-curves) for offchain verification

MIT
