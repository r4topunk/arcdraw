import { describe, expect, it } from "vitest";
import { QUICKNET } from "../src/constants.js";
import { expiryTime, minRequestRound, roundAt, roundTime } from "../src/rounds.js";

const G = QUICKNET.genesisTime;

describe("round math (mirrors ArcDrawCoordinator)", () => {
  it("matches the Solidity reference points", () => {
    expect(roundAt(0n)).toBe(0n);
    expect(roundAt(G - 1n)).toBe(0n);
    expect(roundAt(G)).toBe(1n);
    expect(roundAt(G + 2n)).toBe(1n);
    expect(roundAt(G + 3n)).toBe(2n);
    expect(roundTime(0n)).toBe(G);
    expect(roundTime(1n)).toBe(G);
    expect(roundTime(1000000n)).toBe(1695803364n);
    expect(expiryTime(1000000n)).toBe(1695803364n + 3600n);
  });

  it("roundAt(roundTime(r)) == r and the next round starts 3 s later", () => {
    for (const r of [1n, 2n, 999_999n, 1_000_000n, 32_274_436n]) {
      expect(roundAt(roundTime(r))).toBe(r);
      expect(roundAt(roundTime(r) + 2n)).toBe(r);
      expect(roundAt(roundTime(r) + 3n)).toBe(r + 1n);
    }
  });

  it("minRequestRound is published strictly after t+9 and at most t+12 (SPEC section 2)", () => {
    let seed = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      const t = G + (seed % 2_000_000_000n);
      const min = minRequestRound(t);
      expect(roundTime(min) > t + 9n).toBe(true);
      expect(roundTime(min) <= t + 12n).toBe(true);
    }
  });

  it("equal timestamps give equal pinned rounds", () => {
    const t = 1_758_000_000n;
    expect(minRequestRound(t)).toBe(minRequestRound(t));
    expect(minRequestRound(t)).toBe(roundAt(t) + 4n);
  });
});
