import { describe, expect, it } from "vitest";
import { callbackGasReserve, FULFILL_GAS, gasCostUsdc, worstCaseFulfillBatchGas } from "../src/gas.js";

describe("worst-case fulfillBatch gas (mirrors contracts/test/FulfillBatchGasLimit.t.sol)", () => {
  it("keeps the constants the Solidity bound tests check", () => {
    expect(FULFILL_GAS).toEqual({
      base: 80_000n,
      verifyRound: 250_000n,
      perRequest: 40_000n,
      callbackOverhead: 5_000n,
      coordinatorCallbackReserve: 5_000n,
    });
  });

  it("reserves the full callback budget plus the coordinator's 1/63 + 5,000 check", () => {
    expect(callbackGasReserve(0)).toBe(0n);
    expect(callbackGasReserve(500_000)).toBe(500_000n + 7_936n + 10_000n);
    expect(worstCaseFulfillBatchGas({ freshRound: true, callbackGasLimits: [0] })).toBe(370_000n);
    expect(worstCaseFulfillBatchGas({ freshRound: false, callbackGasLimits: [] })).toBe(80_000n);
    expect(worstCaseFulfillBatchGas({ freshRound: true, callbackGasLimits: [500_000, 500_000, 0] })).toBe(
      80_000n + 250_000n + 3n * 40_000n + 2n * 517_936n,
    );
  });

  it("prices gas in 6-decimal USDC, rounding up", () => {
    expect(gasCostUsdc(370_000n, 20_000_000_000n)).toBe(7_400n); // 0.0074 USDC at Arc's 20 gwei floor
    expect(gasCostUsdc(1n, 1n)).toBe(1n);
    expect(gasCostUsdc(0n, 20_000_000_000n)).toBe(0n);
  });
});
