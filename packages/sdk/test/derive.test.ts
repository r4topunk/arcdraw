import { describe, expect, it } from "vitest";
import { deriveRandomness } from "../src/derive.js";
import { BEACON_A, DERIVE_VECTOR } from "./fixtures.js";

describe("deriveRandomness", () => {
  it("matches the forge-generated vector byte for byte", () => {
    expect(
      deriveRandomness({
        drandRandomness: BEACON_A.randomness,
        chainId: DERIVE_VECTOR.chainId,
        coordinator: DERIVE_VECTOR.coordinator,
        requestId: DERIVE_VECTOR.requestId,
      }),
    ).toBe(DERIVE_VECTOR.expected);
  });

  it("is domain separated by chain, coordinator and request id", () => {
    const base = {
      drandRandomness: BEACON_A.randomness,
      chainId: 5042,
      coordinator: DERIVE_VECTOR.coordinator,
      requestId: 1n,
    } as const;
    const d = deriveRandomness(base);
    expect(deriveRandomness({ ...base, chainId: 5042002 })).not.toBe(d);
    expect(deriveRandomness({ ...base, requestId: 2n })).not.toBe(d);
    expect(deriveRandomness({ ...base, coordinator: "0x0000000000000000000000000000000000000001" })).not.toBe(
      d,
    );
    expect(deriveRandomness({ ...base, chainId: 5042n })).toBe(d);
  });
});
