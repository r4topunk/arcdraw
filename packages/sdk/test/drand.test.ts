import { bytesToHex, type Hex, hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { QUICKNET } from "../src/constants.js";
import {
  assertValidBeacon,
  beaconInvalidReason,
  fetchBeacon,
  isCanonicalCompressedG1,
  verifyBeacon,
} from "../src/drand.js";
import { DrandFetchError, InvalidBeaconError } from "../src/errors.js";
import { BEACON_A, BEACON_B, BEACON_C, drandJson } from "./fixtures.js";

const P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;

const flipFirstByte = (sig: Hex, mask: number): Hex => {
  const b = hexToBytes(sig);
  b[0] = (b[0] ?? 0) ^ mask;
  return bytesToHex(b);
};

describe("verifyBeacon", () => {
  it("accepts real quicknet rounds 1000000..1000002", () => {
    expect(verifyBeacon(BEACON_A)).toBe(true);
    expect(verifyBeacon(BEACON_B)).toBe(true);
    expect(verifyBeacon(BEACON_C)).toBe(true);
    expect(() => assertValidBeacon(BEACON_A)).not.toThrow();
  });

  it("rejects a signature presented for another round", () => {
    expect(verifyBeacon({ ...BEACON_A, round: BEACON_B.round })).toBe(false);
    expect(beaconInvalidReason({ ...BEACON_A, round: BEACON_B.round })).toMatch(/does not verify/);
  });

  it("rejects randomness that is not sha256(signature)", () => {
    expect(beaconInvalidReason({ ...BEACON_A, randomness: BEACON_B.randomness })).toMatch(/sha256/);
  });

  it("rejects a flipped sign bit, cleared compression flag and infinity flag", () => {
    expect(verifyBeacon({ ...BEACON_A, signature: flipFirstByte(BEACON_A.signature, 0x20) })).toBe(false);
    expect(verifyBeacon({ ...BEACON_A, signature: flipFirstByte(BEACON_A.signature, 0x80) })).toBe(false);
    expect(verifyBeacon({ ...BEACON_A, signature: flipFirstByte(BEACON_A.signature, 0x40) })).toBe(false);
    expect(() => assertValidBeacon({ ...BEACON_A, signature: "0x1234" })).toThrow(InvalidBeaconError);
  });

  it("rejects the non-canonical x + p encoding the coordinator also rejects", () => {
    const bytes = hexToBytes(BEACON_A.signature);
    const flags = (bytes[0] ?? 0) & 0xe0;
    bytes[0] = (bytes[0] ?? 0) & 0x1f;
    const x = BigInt(bytesToHex(bytes)) + P;
    expect(x < 2n ** 381n).toBe(true);
    const enc = hexToBytes(`0x${x.toString(16).padStart(96, "0")}`);
    enc[0] = (enc[0] ?? 0) | flags;
    const sig = bytesToHex(enc);
    expect(isCanonicalCompressedG1(BEACON_A.signature)).toBe(true);
    expect(isCanonicalCompressedG1(sig)).toBe(false);
    expect(beaconInvalidReason({ ...BEACON_A, signature: sig })).toMatch(/canonical/);
  });
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("fetchBeacon", () => {
  it("builds the quicknet URL and verifies the response", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => ok(drandJson(BEACON_A)));
    const b = await fetchBeacon(1000000n, {
      urls: ["https://relay.example/"],
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(b).toEqual(BEACON_A);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `https://relay.example/${QUICKNET.chainHash}/public/1000000`,
    );
  });

  it("falls back across relays on HTTP errors, wrong rounds and malformed bodies", async () => {
    const responses = [
      new Response("nope", { status: 500 }),
      ok({ hello: "world" }),
      ok(drandJson(BEACON_B)),
      ok(drandJson(BEACON_A)),
    ];
    const fetch = vi.fn(async () => responses.shift() as Response);
    const b = await fetchBeacon(1000000n, {
      urls: ["https://a", "https://b", "https://c", "https://d"],
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(b.round).toBe(1000000n);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("throws DrandFetchError with every attempt when all relays fail", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await fetchBeacon(5n, {
      urls: ["https://a", "https://b"],
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DrandFetchError);
    expect((err as DrandFetchError).code).toBe("DRAND_FETCH_FAILED");
    expect((err as DrandFetchError).attempts).toHaveLength(2);
  });

  it("throws InvalidBeaconError when a relay serves a forged beacon", async () => {
    const forged = { ...drandJson(BEACON_B), round: 1000000 };
    const fetch = vi.fn(async () => ok(forged));
    await expect(
      fetchBeacon(1000000n, { urls: ["https://a"], fetch: fetch as unknown as typeof globalThis.fetch }),
    ).rejects.toBeInstanceOf(InvalidBeaconError);
    // verify: false skips the BLS check (caller takes responsibility)
    const fetch2 = vi.fn(async () => ok(forged));
    const b = await fetchBeacon(1000000n, {
      urls: ["https://a"],
      verify: false,
      fetch: fetch2 as unknown as typeof globalThis.fetch,
    });
    expect(b.signature).toBe(BEACON_B.signature);
  });

  it("times out slow relays", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      fetchBeacon(1000000n, {
        urls: ["https://slow"],
        timeoutMs: 20,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toBeInstanceOf(DrandFetchError);
  });
});
