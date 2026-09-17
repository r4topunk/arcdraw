import { fetchBeacon as sdkFetchBeacon } from "@arcdraw/sdk";

// drand quicknet helpers come from @arcdraw/sdk so the site, SDK and relayer share one implementation
// (round math mirrors the coordinator; BLS verification via @noble/curves, RFC 9380).
export {
  type Beacon,
  DEFAULT_DRAND_URLS as DRAND_URLS,
  deriveRandomness,
  QUICKNET,
  roundAt,
  roundTime,
  verifyBeacon,
} from "@arcdraw/sdk";

/**
 * Fetch a beacon without throwing on a bad signature: the UI calls `verifyBeacon` itself so it can
 * show a failed check instead of an error.
 */
export const fetchBeacon = (round: bigint | "latest", signal?: AbortSignal) =>
  sdkFetchBeacon(round, { signal, verify: false });
