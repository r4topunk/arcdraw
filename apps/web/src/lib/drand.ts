import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** drand quicknet (League of Entropy): BLS12-381 G1 unchained signatures, RFC 9380. */
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367n,
  period: 3n,
  dst: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
} as const;

export const DRAND_URLS = ["https://api.drand.sh", "https://api2.drand.sh", "https://drand.cloudflare.com"];

/** Mirrors ArcDrawCoordinator.currentRound(t). */
export const roundAt = (t: bigint): bigint =>
  t < QUICKNET.genesisTime ? 0n : (t - QUICKNET.genesisTime) / QUICKNET.period + 1n;

/** Mirrors ArcDrawCoordinator.roundTimestamp(round). */
export const roundTime = (round: bigint): bigint =>
  round === 0n ? QUICKNET.genesisTime : QUICKNET.genesisTime + (round - 1n) * QUICKNET.period;

export type Beacon = { round: bigint; signature: Hex; randomness: Hex };

export async function fetchBeacon(round: bigint | "latest", signal?: AbortSignal): Promise<Beacon> {
  let lastErr: unknown;
  for (const base of DRAND_URLS) {
    try {
      const res = await fetch(`${base}/${QUICKNET.chainHash}/public/${round.toString()}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`drand ${base} responded ${res.status}`);
      const j = (await res.json()) as { round: number; signature: string; randomness: string };
      return { round: BigInt(j.round), signature: `0x${j.signature}`, randomness: `0x${j.randomness}` };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("All drand endpoints failed");
}

/**
 * Verify a quicknet beacon in the browser: BLS signature over sha256(uint64be(round)) and
 * randomness == sha256(signature). Same checks the coordinator runs onchain.
 */
export function verifyBeacon(b: Beacon): boolean {
  try {
    const roundBytes = new Uint8Array(8);
    new DataView(roundBytes.buffer).setBigUint64(0, b.round);
    const msg = bls.G1.hashToCurve(sha256(roundBytes), { DST: QUICKNET.dst });
    const sig = hexToBytes(b.signature.slice(2));
    const ok = bls.shortSignatures.verify(sig, msg, hexToBytes(QUICKNET.publicKey));
    return ok && `0x${bytesToHex(sha256(sig))}` === b.randomness.toLowerCase();
  } catch {
    return false;
  }
}

/** keccak256(abi.encode(drandRandomness, chainId, coordinator, requestId)). */
export function deriveRandomness(a: { drandRandomness: Hex; chainId: number; coordinator: Address; requestId: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [a.drandRandomness, BigInt(a.chainId), a.coordinator, a.requestId],
    ),
  );
}
