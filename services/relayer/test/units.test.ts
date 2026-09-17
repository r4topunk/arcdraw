import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { backoffDelay, withRetry } from "../src/retry.js";
import { emptyState, FileStateStore, parseState, serializeState } from "../src/state.js";

const COORD = "0x00000000000000000000000000000000a4cd4a11";
// Shape-valid placeholder, not a real key.
const FAKE_KEY = `0x${"ab".repeat(32)}`;

describe("config", () => {
  it("applies defaults and parses units", () => {
    const c = loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true", RELAYER_MIN_BOUNTY: "0.01" });
    expect(c.chainId).toBe(5042);
    expect(c.rpcUrl).toBe("https://rpc.mainnet.arc.io");
    expect(c.coordinator).toBe("0x00000000000000000000000000000000A4Cd4A11");
    expect(c.minBounty).toBe(10_000n);
    expect(c.maxGasPrice).toBe(100_000_000_000n);
    expect(c.drandUrls).toHaveLength(3);
    expect(c.dryRun).toBe(true);
    expect(c.scanChunk).toBe(10_000n);
  });

  it("requires a key unless dry-run, and a coordinator when none is deployed", () => {
    expect(() => loadConfig({ COORDINATOR_ADDRESS: COORD })).toThrow(/RELAYER_PRIVATE_KEY is required/);
    expect(() => loadConfig({ RELAYER_DRY_RUN: "true" })).toThrow(/COORDINATOR_ADDRESS is required/);
    expect(() => loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_PRIVATE_KEY: FAKE_KEY })).not.toThrow();
  });

  it("never echoes the private key in errors or in describeConfig", () => {
    const badKey = `0x${"cd".repeat(31)}`;
    let msg = "";
    try {
      loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_PRIVATE_KEY: badKey });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/RELAYER_PRIVATE_KEY/);
    expect(msg).not.toContain("cdcd");
    const c = loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_PRIVATE_KEY: FAKE_KEY });
    expect(
      JSON.stringify(describeConfig(c), (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("abab");
  });

  it("rejects bad values", () => {
    expect(() =>
      loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true", RELAYER_SCAN_CHUNK: "20000" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true", RELAYER_MIN_BOUNTY: "0.0000001" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true", DRAND_URLS: "nope" }),
    ).toThrow(ConfigError);
  });
});

describe("logger", () => {
  it("writes one JSON object per line with level, correlation ids, bigint and redaction", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "info",
      bindings: { runId: "r1" },
      write: (l) => lines.push(l),
      now: () => new Date(0),
    });
    log.debug("hidden");
    log
      .child({ tickId: "t1" })
      .child({ round: 5n })
      .info("hello", { requestIds: [1n, 2n], privateKey: "0xdead" });
    log.error("boom", { err: new Error("bad\nstack") });
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] as string);
    expect(a).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "hello",
      service: "relayer",
      runId: "r1",
      tickId: "t1",
      round: "5",
      requestIds: ["1", "2"],
      privateKey: "[REDACTED]",
    });
    expect(JSON.parse(lines[1] as string).err).toEqual({ name: "Error", message: "bad" });
  });
});

describe("retry", () => {
  it("backs off exponentially with jitter, capped", () => {
    expect(backoffDelay(1, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 1000, () => 1)).toBe(400);
    expect(backoffDelay(10, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(200);
  });

  it("retries until success, stops on non-retryable errors", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    await expect(
      withRetry(
        async () => {
          if (++n < 3) throw new Error("flaky");
          return "ok";
        },
        { sleep },
      ),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(2);

    const fatal = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(withRetry(fatal, { sleep, shouldRetry: () => false })).rejects.toThrow("fatal");
    expect(fatal).toHaveBeenCalledTimes(1);

    const always = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(withRetry(always, { sleep, attempts: 3 })).rejects.toThrow("down");
    expect(always).toHaveBeenCalledTimes(3);
  });
});

describe("state", () => {
  it("round-trips through JSON and writes atomically", async () => {
    const s = emptyState(5042, COORD);
    s.lastScannedBlock = 123n;
    s.pending.set(7n, { round: 1000000n, bounty: 10_000n });
    s.inflight.set(`0x${"11".repeat(32)}`, {
      txHash: `0x${"11".repeat(32)}`,
      round: 1000000n,
      requestIds: [7n],
      sentAt: 1,
      nonce: 3,
    });
    s.quarantine.set(7n, { strikes: 2, notBefore: 99, maxGroup: 1 });
    s.quarantine.set(8n, { strikes: 0, notBefore: 5 });
    expect(parseState(serializeState(s))).toEqual(s);

    const dir = await mkdtemp(join(tmpdir(), "arcdraw-state-"));
    try {
      const store = new FileStateStore(join(dir, "nested", "cursor.json"));
      expect(await store.load()).toBeUndefined();
      await store.save(s);
      expect(await store.load()).toEqual(s);
      expect(JSON.parse(await readFile(store.path, "utf8")).lastScannedBlock).toBe("123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("state migration", () => {
  it("reads state files written before per-transaction inflight tracking (keyed by round, no quarantine)", () => {
    const legacy = JSON.stringify({
      version: 1,
      chainId: 5042,
      coordinator: COORD,
      lastScannedBlock: "10",
      pending: { "7": { round: "1000000", bounty: "0" } },
      inflight: { "1000000": { txHash: `0x${"22".repeat(32)}`, requestIds: ["7"], sentAt: 5, nonce: 1 } },
    });
    const s = parseState(legacy);
    expect([...s.inflight.values()]).toEqual([
      { txHash: `0x${"22".repeat(32)}`, round: 1000000n, requestIds: [7n], sentAt: 5, nonce: 1 },
    ]);
    expect(s.inflight.has(`0x${"22".repeat(32)}`)).toBe(true);
    expect(s.quarantine.size).toBe(0);
  });
});

describe("profitability config (R2)", () => {
  it("defaults to a 120% cost margin, no sponsors and the coordinator's callback gas maximum", () => {
    const c = loadConfig({ COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true" });
    expect(c.costMarginPct).toBe(120);
    expect(c.sponsoredRequesters).toEqual([]);
    expect(c.maxCallbackGas).toBe(500_000);
  });

  it("parses sponsors and caps, and rejects bad values", () => {
    const c = loadConfig({
      COORDINATOR_ADDRESS: COORD,
      RELAYER_DRY_RUN: "true",
      RELAYER_COST_MARGIN_PCT: "0",
      RELAYER_SPONSORED_REQUESTERS: ` ${COORD.toUpperCase().replace("0X", "0x")} , 0x000000000000000000000000000000000000bEEF`,
      RELAYER_MAX_CALLBACK_GAS: "100000",
    });
    expect(c.costMarginPct).toBe(0);
    expect(c.sponsoredRequesters).toEqual([
      "0x00000000000000000000000000000000A4Cd4A11",
      "0x000000000000000000000000000000000000bEEF",
    ]);
    expect(c.maxCallbackGas).toBe(100_000);
    const base = { COORDINATOR_ADDRESS: COORD, RELAYER_DRY_RUN: "true" };
    expect(() => loadConfig({ ...base, RELAYER_SPONSORED_REQUESTERS: "0x1234" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RELAYER_MAX_CALLBACK_GAS: "500001" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RELAYER_COST_MARGIN_PCT: "-1" })).toThrow(ConfigError);
  });
});

describe("config placeholders", () => {
  it("treats .env.example placeholders as unset", () => {
    const c = loadConfig({
      COORDINATOR_ADDRESS: COORD,
      RELAYER_DRY_RUN: "true",
      RELAYER_PRIVATE_KEY: "[RELAYER_PRIVATE_KEY]",
    });
    expect(c.privateKey).toBeUndefined();
  });
});
