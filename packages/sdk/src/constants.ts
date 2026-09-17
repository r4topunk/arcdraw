import type { Address } from "viem";

/** drand quicknet (League of Entropy): BLS12-381, G1 signatures, unchained, RFC 9380 hash-to-curve. */
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  scheme: "bls-unchained-g1-rfc9380",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367n,
  period: 3n,
  dst: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
} as const;

/** Public drand HTTP relays, tried in order. */
export const DEFAULT_DRAND_URLS = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://drand.cloudflare.com",
] as const;

/** USDC ERC-20 interface on Arc (6 decimals; same balance as native gas USDC). */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

/** Mirrors the coordinator constants (see docs/SPEC.md section 0). */
export const COORDINATOR_LIMITS = {
  minRoundDelay: 2n,
  maxRoundDelay: 10_512_000n,
  maxCallbackGasLimit: 500_000,
  requestTimeout: 3600n,
} as const;

/** Arc `eth_getLogs` accepts at most 10,000 blocks per call. */
export const MAX_LOG_RANGE = 10_000n;
