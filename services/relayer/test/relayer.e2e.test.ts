import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArcDrawClient,
  type Beacon,
  createArcDraw,
  deriveRandomness,
  InvalidBeaconError,
  roundTime,
} from "@arcdraw/sdk";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { run as runRelayer } from "../src/main.js";
import { Relayer } from "../src/relayer.js";
import { MemoryStateStore } from "../src/state.js";
import { anvilAvailable, artifact, startAnvil } from "./anvil.js";

// Real quicknet beacons (same as contracts/test/fixtures/Quicknet.sol).
const BEACONS = new Map<bigint, Beacon>([
  [
    1000000n,
    {
      round: 1000000n,
      signature:
        "0x83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
      randomness: "0xb22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
    },
  ],
  [
    1000001n,
    {
      round: 1000001n,
      signature:
        "0xa5bd91e5e2d8c0bf51bffdfad87eef34348fd9c0b2df2bee39db90bdef7e1399b1a77bb2fe98b24d84c0936a306c4218",
      randomness: "0x9f45f439afd81e9846b3b4dc5e3e6051922c73c8459d18e9d507b52ddbd884ff",
    },
  ],
  [
    1000002n,
    {
      round: 1000002n,
      signature:
        "0xa96e2a020098645aa4f912dcca317a67e98c39909fe1a037798fb503f04272b8153bab438c7e8d298593af1bdf29e5c5",
      randomness: "0x018e0e0c9e0d7906762eca633fab3ec5e97ee4cb8949e4eb9ee589160b49263d",
    },
  ],
]);

const mockDrand = async (round: bigint): Promise<Beacon> => {
  const b = BEACONS.get(round);
  if (!b) throw new InvalidBeaconError(round, "no fixture");
  return b;
};

const suite = anvilAvailable() ? describe : describe.skip;

suite("relayer against anvil (Osaka) with real quicknet signatures", () => {
  // Genesis a minute before round 1000000 is published, so requests can pin rounds 1000000..1000002.
  const GENESIS_TS = roundTime(1000000n) - 60n;
  let anvil: { url: string; stop: () => void };
  let publicClient: PublicClient;
  let requesterWallet: WalletClient;
  let relayerAddr: Address;
  let requester: Address;
  let usdc: Address;
  let coordinator: Address;
  let consumer: Address;
  let consumerAbi: Abi;
  let sdk: ArcDrawClient;
  const logs: Record<string, unknown>[] = [];

  const rpc = (method: string, params: unknown[]) => publicClient.request({ method, params } as never);
  const mineAt = async (ts: bigint) => {
    await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
    await rpc("evm_mine", []);
  };
  const deploy = async (file: string, name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const hash = await requesterWallet.deployContract({
      abi,
      bytecode,
      args,
      account: requester,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress as Address;
  };
  const makeRelayer = (o: { dryRun: boolean; store?: MemoryStateStore }) => {
    const wallet = createWalletClient({
      transport: http(anvil.url),
      account: relayerAddr,
      chain: publicClient.chain,
    });
    const client = createArcDraw({ publicClient, walletClient: wallet, coordinator });
    const logger = createLogger({ level: "debug", write: (l) => logs.push(JSON.parse(l)) });
    return new Relayer({
      client,
      publicClient,
      account: relayerAddr,
      store: o.store ?? new MemoryStateStore(),
      logger,
      fetchBeacon: mockDrand,
      chainId: 31337,
      dryRun: o.dryRun,
      startBlock: 0n,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
  };

  beforeAll(async () => {
    anvil = await startAnvil({ timestamp: GENESIS_TS });
    const chain = defineChain({
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    });
    publicClient = createPublicClient({
      chain,
      transport: http(anvil.url),
      pollingInterval: 50,
    }) as PublicClient;
    const accounts = (await rpc("eth_accounts", [])) as Address[];
    requester = accounts[0] as Address;
    relayerAddr = accounts[1] as Address;
    requesterWallet = createWalletClient({ chain, transport: http(anvil.url), account: requester });

    usdc = await deploy("MockUSDC.sol", "MockUSDC", []);
    coordinator = await deploy("ArcDrawCoordinator.sol", "ArcDrawCoordinator", [usdc]);
    const rc = artifact("Consumers.sol", "RecordingConsumer");
    consumerAbi = rc.abi;
    consumer = await deploy("Consumers.sol", "RecordingConsumer", [coordinator]);
    sdk = createArcDraw({ publicClient, walletClient: requesterWallet, coordinator });

    const mockUsdcAbi = artifact("MockUSDC.sol", "MockUSDC").abi;
    const mint = await requesterWallet.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [requester, 1_000_000n],
      account: requester,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: mint });
  });

  afterAll(() => anvil?.stop());

  const dryStore = new MemoryStateStore();

  it("scans, waits for the round, batch-fulfills with a bounty, runs callbacks, and is idempotent", async () => {
    // Two EOA requests on round 1000000 (0.01 USDC bounty each, SDK auto-approves), one on 1000001, one on 1000002.
    await mineAt(GENESIS_TS + 5n);
    const a = await sdk.request({ round: 1000000n, bounty: 10_000n });
    const b = await sdk.request({ round: 1000000n, bounty: 10_000n });
    const c = await sdk.request({ round: 1000001n });
    const d = await sdk.request({ round: 1000002n });
    expect([a.requestId, b.requestId, c.requestId, d.requestId]).toEqual([1n, 2n, 3n, 4n]);
    expect(a.round).toBe(1000000n);

    // Consumer request through requestRandomness(): at roundTime(999998) the pinned round is 1000000.
    await rpc("evm_setNextBlockTimestamp", [Number(roundTime(999998n))]);
    const hash = await requesterWallet.writeContract({
      address: consumer,
      abi: consumerAbi,
      functionName: "request",
      args: [150_000, 0n],
      account: requester,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    expect((await sdk.getRequest(5n)).round).toBe(1000000n);

    const store = new MemoryStateStore();
    const relayer = makeRelayer({ dryRun: false, store });

    // Rounds not published yet: requests are tracked, nothing is sent.
    const early = await relayer.tick();
    expect(early.due).toBe(0);
    expect(early.sent).toHaveLength(0);
    expect((await store.load())?.pending.size).toBe(5);

    // Past rounds 1000000 and 1000001, before 1000002.
    await mineAt(roundTime(1000001n) + 1n);
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });
    const t = await relayer.tick();
    expect(t.due).toBe(4);
    expect(t.sent).toHaveLength(2); // one batch per round
    expect([...t.fulfilled].sort()).toEqual([1n, 2n, 3n, 5n]);
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore + 2);

    for (const id of [1n, 2n, 5n]) {
      const r = await sdk.getRequest(id);
      expect(r.status).toBe("fulfilled");
      expect(r.randomness).toBe(
        deriveRandomness({
          drandRandomness: (BEACONS.get(1000000n) as Beacon).randomness,
          chainId: 31337,
          coordinator,
          requestId: id,
        }),
      );
    }
    const bal = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [relayerAddr],
    });
    expect(bal).toBe(20_000n);
    const calls = await publicClient.readContract({
      address: consumer,
      abi: consumerAbi,
      functionName: "calls",
    });
    expect(calls).toBe(1n);
    const last = await publicClient.readContract({
      address: consumer,
      abi: consumerAbi,
      functionName: "lastRandomness",
    });
    expect(last).toBe((await sdk.getRequest(5n)).randomness);

    const fulfilledLog = logs.find((l) => l.msg === "fulfilled" && l.round === "1000000");
    expect(fulfilledLog).toMatchObject({
      level: "info",
      batch_size: 3,
      bountyPaid: "20000",
      service: "relayer",
      callbacksFailed: [],
      requestIds: ["1", "2", "5"],
    });
    expect(fulfilledLog?.tickId).toBe(t.tickId);
    expect(fulfilledLog?.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Idempotent: a second tick, and a fresh relayer replaying all logs from block 0, send nothing.
    const again = await relayer.tick();
    expect(again.sent).toHaveLength(0);
    expect([...((await store.load())?.pending.keys() ?? [])]).toEqual([4n]);
    const replay = await makeRelayer({ dryRun: false }).tick();
    expect(replay.due).toBe(0);
    expect(replay.sent).toHaveLength(0);
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore + 2);
  });

  it("dry-run simulates with eth_call/estimateGas and never sends", async () => {
    await mineAt(roundTime(1000002n) + 1n);
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });
    const t = await makeRelayer({ dryRun: true, store: dryStore }).tick();
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore);
    expect(t.sent).toHaveLength(0);
    expect(t.simulated).toHaveLength(1);
    expect(t.simulated[0]?.requestIds).toEqual([4n]);
    expect(t.simulated[0]?.gas).toBeGreaterThan(200_000n); // fresh BLS verification
    expect((await sdk.getRequest(4n)).status).toBe("pending");
    expect(
      logs.some((l) => l.msg === "dry_run_would_fulfill" && l.tickId === t.tickId && l.round === "1000002"),
    ).toBe(true);
    expect((await dryStore.load())?.pending.has(4n)).toBe(true);
  });

  it("drops a request another fulfiller settled after the scan (lost race) without sending", async () => {
    // Someone else fulfills request 4 with the SDK.
    const hash = await sdk.fulfill(4n, { beacon: BEACONS.get(1000002n) });
    await publicClient.waitForTransactionReceipt({ hash });
    expect((await sdk.getRequest(4n)).status).toBe("fulfilled");

    // Stale view: cursor already at head, so the Fulfilled log is not scanned; the status re-read catches it.
    const stale = (await dryStore.load()) as NonNullable<Awaited<ReturnType<MemoryStateStore["load"]>>>;
    stale.lastScannedBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    await dryStore.save(stale);
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });
    const t = await makeRelayer({ dryRun: false, store: dryStore }).tick();
    expect(t.due).toBe(1);
    expect(t.sent).toHaveLength(0);
    expect((await dryStore.load())?.pending.has(4n)).toBe(false);
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore);
  });

  it("rejects a forged beacon offchain without sending", async () => {
    await mineAt(roundTime(1000002n) + 5n);
    // Request on a round the fixtures do not cover.
    const next = (await publicClient.readContract({
      address: coordinator,
      abi: artifact("ArcDrawCoordinator.sol", "ArcDrawCoordinator").abi,
      functionName: "minRequestRound",
    })) as bigint;
    const req = await sdk.request({ round: next });
    await mineAt(roundTime(next) + 1n);
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });
    const t = await makeRelayer({ dryRun: false }).tick();
    expect(t.sent).toHaveLength(0);
    expect(t.skipped).toContainEqual({ round: req.round, reason: "invalid_beacon" });
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore);

    // A batch recorded as in flight (e.g. sent just before a restart) is not resubmitted while unconfirmed.
    const store = new MemoryStateStore();
    const withInflight = makeRelayer({ dryRun: false, store });
    await withInflight.tick(); // populate cursor + pending
    const st = (await store.load()) as NonNullable<Awaited<ReturnType<MemoryStateStore["load"]>>>;
    st.inflight.set(req.round, {
      txHash: `0x${"ab".repeat(32)}`,
      requestIds: [req.requestId],
      sentAt: Date.now(),
    });
    await store.save(st);
    const t2 = await makeRelayer({ dryRun: false, store }).tick();
    expect(t2.skipped).toContainEqual({ round: req.round, reason: "inflight" });
    expect(t2.sent).toHaveLength(0);
  });

  it("run() wires env config, loops, and shuts down gracefully on abort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcdraw-run-"));
    try {
      const config = loadConfig({
        ARC_RPC_URL: anvil.url,
        ARC_CHAIN_ID: "31337",
        COORDINATOR_ADDRESS: coordinator,
        RELAYER_START_BLOCK: "0",
        RELAYER_DRY_RUN: "true",
        RELAYER_ADDRESS: relayerAddr,
        RELAYER_POLL_MS: "100",
        RELAYER_STATE_FILE: join(dir, "cursor.json"),
        LOG_LEVEL: "debug",
      });
      const controller = new AbortController();
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({
        level: "debug",
        bindings: { runId: "test-run" },
        write: (l) => {
          const o = JSON.parse(l);
          lines.push(o);
          if (o.msg === "tick_done" && lines.filter((x) => x.msg === "tick_done").length >= 2)
            controller.abort();
        },
      });
      const code = await runRelayer(config, logger, controller.signal);
      expect(code).toBe(0);
      expect(lines[0]).toMatchObject({
        msg: "relayer_started",
        dryRun: true,
        hasPrivateKey: false,
        runId: "test-run",
      });
      expect(lines.at(-1)).toMatchObject({ msg: "relayer_stopped", exitCode: 0 });
      const saved = JSON.parse(await readFile(join(dir, "cursor.json"), "utf8"));
      expect(BigInt(saved.lastScannedBlock)).toBeGreaterThan(0n);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
