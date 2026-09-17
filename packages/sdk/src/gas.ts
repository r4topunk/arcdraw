/**
 * Simulation-independent upper bound for the gas of `fulfillBatch`.
 *
 * `eth_estimateGas` only measures what a callback does *in the simulation*. A consumer can behave cheaply there
 * (for example when `tx.gasprice == 0`) and burn its whole `callbackGasLimit` in the real transaction, so a gas
 * limit derived from the estimate makes the batch revert with `InsufficientGasForCallback` (audit finding R1).
 * The bound below assumes every callback uses its full budget and keeps the coordinator's reserve
 * (`callbackGasLimit + callbackGasLimit / 63 + 5,000`, see `ArcDrawCoordinator._callback`) available for each.
 *
 * Constants come from docs/GAS.md (isolated transactions, real quicknet signatures) with ~20% headroom:
 * fresh-round `fulfill` without callback measures 313,410 gas, a 5-id batch 446,870 (~33.4k per extra id),
 * `verifyRound` ~236k execution gas. Mirrored in `contracts/test/FulfillBatchGasLimit.t.sol`, which checks the
 * bound against real executions.
 */
export const FULFILL_GAS = {
  /** Intrinsic gas, calldata head, dispatch and the single bounty transfer. */
  base: 80_000n,
  /** BLS verification, signature storage and `RoundVerified` when the round is not verified yet. */
  verifyRound: 250_000n,
  /** Per request id: status reads, settle writes, randomness derivation, event, calldata word. */
  perRequest: 40_000n,
  /** Per callback on top of its reserve: `extcodesize`, call, abi encoding. */
  callbackOverhead: 5_000n,
  /** Fixed part of the coordinator's gas check (`CALLBACK_GAS_OVERHEAD`). */
  coordinatorCallbackReserve: 5_000n,
} as const;

/** Gas one callback can consume or must leave available: 0 when `callbackGasLimit` is 0. */
export function callbackGasReserve(callbackGasLimit: number | bigint): bigint {
  const cb = BigInt(callbackGasLimit);
  if (cb <= 0n) return 0n;
  return cb + cb / 63n + FULFILL_GAS.coordinatorCallbackReserve + FULFILL_GAS.callbackOverhead;
}

/** Worst-case gas of `fulfillBatch` for requests with these callback gas limits (one entry per id). */
export function worstCaseFulfillBatchGas(o: {
  /** true when `roundRandomness(round)` is still 0, so the BLS signature is verified in this tx. */
  freshRound: boolean;
  callbackGasLimits: readonly (number | bigint)[];
}): bigint {
  let gas = FULFILL_GAS.base + (o.freshRound ? FULFILL_GAS.verifyRound : 0n);
  for (const cb of o.callbackGasLimits) gas += FULFILL_GAS.perRequest + callbackGasReserve(cb);
  return gas;
}

/**
 * Cost in USDC base units (6 decimals, rounded up) of `gas` at `gasPriceWei`.
 * Arc's native gas token is USDC with 18 decimals, so 1 USDC unit = 10^12 wei.
 */
export function gasCostUsdc(gas: bigint, gasPriceWei: bigint): bigint {
  const wei = gas * gasPriceWei;
  return (wei + 999_999_999_999n) / 1_000_000_000_000n;
}
