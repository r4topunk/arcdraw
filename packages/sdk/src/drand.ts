import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { z } from "zod";
import { DEFAULT_DRAND_URLS, QUICKNET } from "./constants.js";
import { DrandFetchError, InvalidBeaconError } from "./errors.js";

/** A drand quicknet beacon. `signature` is the 48-byte compressed G1 point, `randomness` is sha256(signature). */
export type Beacon = { round: bigint; signature: Hex; randomness: Hex };

const hexString = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`), `expected ${bytes} bytes of hex`)
    .transform((s) => (s.startsWith("0x") ? s.toLowerCase() : `0x${s.toLowerCase()}`) as Hex);

/** Shape of `GET /{chainHash}/public/{round}` on the drand HTTP API. */
export const drandBeaconResponseSchema = z.object({
  round: z.number().int().positive(),
  randomness: hexString(32),
  signature: hexString(48),
});

export type FetchBeaconOptions = {
  /** drand HTTP relays tried in order. Default: api.drand.sh, api2.drand.sh, drand.cloudflare.com. */
  urls?: readonly string[];
  /** Per-endpoint timeout. Default 5000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Verify the BLS signature before returning (default true). Throws `InvalidBeaconError` on failure. */
  verify?: boolean;
  /** Injectable fetch (tests, custom agents). Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Fetch a quicknet beacon over HTTP, falling back across `urls`.
 * Throws `DrandFetchError` if no endpoint returns a well-formed beacon for that round, which
 * includes the normal case of asking for a round that is not published yet.
 */
export async function fetchBeacon(round: bigint | "latest", opts: FetchBeaconOptions = {}): Promise<Beacon> {
  const urls = opts.urls && opts.urls.length > 0 ? opts.urls : DEFAULT_DRAND_URLS;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const attempts: { url: string; error: string }[] = [];
  let invalid: InvalidBeaconError | undefined;

  for (const base of urls) {
    opts.signal?.throwIfAborted();
    const url = `${base.replace(/\/+$/, "")}/${QUICKNET.chainHash}/public/${round === "latest" ? "latest" : round.toString()}`;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await doFetch(url, { signal, headers: { accept: "application/json" } });
      if (!res.ok) {
        attempts.push({ url, error: `HTTP ${res.status}` });
        continue;
      }
      const parsed = drandBeaconResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        attempts.push({ url, error: `malformed response: ${parsed.error.issues[0]?.message ?? "invalid"}` });
        continue;
      }
      const beacon: Beacon = {
        round: BigInt(parsed.data.round),
        signature: parsed.data.signature,
        randomness: parsed.data.randomness,
      };
      if (round !== "latest" && beacon.round !== round) {
        attempts.push({ url, error: `asked for round ${round}, got ${beacon.round}` });
        continue;
      }
      if (opts.verify !== false) {
        const reason = beaconInvalidReason(beacon);
        if (reason) {
          // A relay serving a bad beacon is suspicious; try the others, then surface it.
          invalid = new InvalidBeaconError(beacon.round, reason);
          attempts.push({ url, error: invalid.message });
          continue;
        }
      }
      return beacon;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      attempts.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (invalid) throw invalid;
  throw new DrandFetchError(round, attempts);
}

// BLS12-381 base field modulus.
const P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;

/**
 * Same canonical-encoding rule the coordinator enforces: compression flag set, infinity flag clear, x < p.
 * A non-canonical encoding would be rejected onchain with `InvalidSignature`.
 */
export function isCanonicalCompressedG1(signature: Hex): boolean {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 48) return false;
  const first = bytes[0] ?? 0;
  if ((first & 0x80) === 0 || (first & 0x40) !== 0) return false;
  const masked = Uint8Array.from(bytes);
  masked[0] = first & 0x1f;
  return BigInt(bytesToHex(masked)) < P;
}

/** drand message for a round: sha256(uint64_be(round)). */
export function roundMessage(round: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, round);
  return sha256(buf);
}

const publicKeyBytes = hexToBytes(`0x${QUICKNET.publicKey}`);

/** Returns why a beacon is invalid, or `undefined` if it verifies. */
export function beaconInvalidReason(beacon: Beacon): string | undefined {
  if (beacon.round <= 0n || beacon.round >= 2n ** 64n) return "round out of range";
  if (!/^0x[0-9a-fA-F]{96}$/.test(beacon.signature)) return "signature must be 48 bytes";
  if (!isCanonicalCompressedG1(beacon.signature)) return "signature is not a canonical compressed G1 point";
  const sigBytes = hexToBytes(beacon.signature);
  if (bytesToHex(sha256(sigBytes)) !== beacon.randomness.toLowerCase())
    return "randomness != sha256(signature)";
  try {
    const bls = bls12_381.shortSignatures;
    const msg = bls.hash(roundMessage(beacon.round), QUICKNET.dst);
    return bls.verify(sigBytes, msg, publicKeyBytes) ? undefined : "BLS signature does not verify";
  } catch (err) {
    return `signature decoding failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Verify a quicknet beacon offchain (noble BLS12-381, RFC 9380), including sha256(signature) == randomness. */
export function verifyBeacon(beacon: Beacon): boolean {
  return beaconInvalidReason(beacon) === undefined;
}

/** Throw `InvalidBeaconError` unless the beacon verifies. */
export function assertValidBeacon(beacon: Beacon): void {
  const reason = beaconInvalidReason(beacon);
  if (reason) throw new InvalidBeaconError(beacon.round, reason);
}
