import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";

export type DeriveRandomnessArgs = {
  /** sha256(signature), as stored in `roundRandomness(round)` and published by drand. */
  drandRandomness: Hex;
  chainId: number | bigint;
  coordinator: Address;
  requestId: bigint;
};

/**
 * Per-request randomness, byte-for-byte equal to the coordinator:
 * `keccak256(abi.encode(drandRandomness, block.chainid, coordinator, requestId))`.
 */
export function deriveRandomness(a: DeriveRandomnessArgs): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [a.drandRandomness, BigInt(a.chainId), a.coordinator, a.requestId],
    ),
  );
}
