// @arcdraw/sdk (stage 1 stub). API contract: docs/SPEC.md section 6.

/** drand quicknet (League of Entropy), BLS12-381 G1 unchained, RFC 9380. */
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367n,
  period: 3n,
  dst: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
} as const;

/** Latest round due at unix time `t` (seconds). Mirrors ArcDrawCoordinator.currentRound(). */
export const roundAt = (t: bigint): bigint =>
  t < QUICKNET.genesisTime ? 0n : (t - QUICKNET.genesisTime) / QUICKNET.period + 1n;

/** Unix time (seconds) at which `round` is published. Mirrors roundTimestamp(). */
export const roundTime = (round: bigint): bigint => QUICKNET.genesisTime + (round - 1n) * QUICKNET.period;

export { arcDrawCoordinatorAbi, arcDrawConsumerAbi, fairAllocationAbi } from "./generated/abis.js";
