import { type ArcDrawClient, type Beacon, createArcDraw, roundAt, roundTime } from "@arcdraw/sdk";
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodePacked,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  sha256,
  slice,
  type WalletClient,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { Relayer } from "../src/relayer.js";
import { MemoryStateStore } from "../src/state.js";
import { anvilAvailable, artifact, startAnvil } from "./anvil.js";

/** Mirrors `fakeSignature` in contracts/test/mocks/TestCoordinator.sol (BLS check replaced, everything else real). */
const fakeSignature = (round: bigint): Hex => {
  const h = keccak256(encodePacked(["string", "uint64"], ["arcdraw-fake-sig", round]));
  const h2 = keccak256(h);
  return concat(["0x8000", h, slice(h2, 0, 14)]);
};
const fakeDrand = async (round: bigint): Promise<Beacon> => {
  const signature = fakeSignature(round);
  return { round, signature, randomness: sha256(signature) };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const suite = anvilAvailable() ? describe : describe.skip;

suite("relayer recovery paths (anvil, TestCoordinator)", () => {
  const GENESIS_TS = roundTime(2000000n) - 60n;
  let anvil: { url: string; stop: () => void };
  let publicClient: PublicClient;
  let wallet: WalletClient;
  let requester: Address;
  let relayerAddr: Address;
  let coordinator: Address;
  let sdk: ArcDrawClient;
  const logs: Record<string, unknown>[] = [];
  let clockOffsetMs = 0;

  const rpc = (method: string, params: unknown[]) => publicClient.request({ method, params } as never);
  const mineAt = async (ts: bigint) => {
    await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
    await rpc("evm_mine", []);
  };
  const deploy = async (file: string, name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const hash = await wallet.deployContract({ abi, bytecode, args, account: requester, chain: null });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  const makeRelayer = (o: {
    store: MemoryStateStore;
    minBounty?: bigint;
    receiptTimeoutMs?: number;
    sponsoredRequesters?: Address[];
  }) =>
    new Relayer({
      client: createArcDraw({
        publicClient,
        walletClient: createWalletClient({
          transport: http(anvil.url),
          account: relayerAddr,
          chain: publicClient.chain,
        }),
        coordinator,
      }),
      publicClient,
      account: relayerAddr,
      store: o.store,
      logger: createLogger({ level: "debug", write: (l) => logs.push(JSON.parse(l)) }),
      fetchBeacon: fakeDrand,
      chainId: 31337,
      dryRun: false,
      startBlock: 0n,
      minBounty: o.minBounty ?? 0n,
      receiptTimeoutMs: o.receiptTimeoutMs ?? 60_000,
      sponsoredRequesters: o.sponsoredRequesters ?? [],
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      now: () => Date.now() + clockOffsetMs,
    });

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
    wallet = createWalletClient({ chain, transport: http(anvil.url), account: requester });
    const usdc = await deploy("MockUSDC.sol", "MockUSDC", []);
    coordinator = await deploy("TestCoordinator.sol", "TestCoordinator", [usdc]);
    sdk = createArcDraw({ publicClient, walletClient: wallet, coordinator });
    const mint = await wallet.writeContract({
      address: usdc,
      abi: artifact("MockUSDC.sol", "MockUSDC").abi,
      functionName: "mint",
      args: [requester, 1_000_000n],
      account: requester,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: mint });
  });

  afterAll(() => anvil?.stop());

  it("stops tracking requests below RELAYER_MIN_BOUNTY, including refunded ones", async () => {
    await mineAt(GENESIS_TS + 5n);
    const paying = await sdk.request({ round: 2000000n, bounty: 10_000n });
    const free = await sdk.request({ round: 2000000n });
    const refunded = await sdk.request({ round: 2000000n, bounty: 10_000n });

    const store = new MemoryStateStore();
    const relayer = makeRelayer({ store, minBounty: 5_000n });
    const early = await relayer.tick();
    expect(early.due).toBe(0);
    // The zero-bounty request is never tracked: a bounty can only go down.
    expect([...((await store.load())?.pending.keys() ?? [])].sort()).toEqual([
      paying.requestId,
      refunded.requestId,
    ]);
    expect(
      logs.some(
        (l) => l.msg === "skip_below_floor" && JSON.stringify(l.requestIds) === `["${free.requestId}"]`,
      ),
    ).toBe(true);

    // One request expires and is refunded (effective bounty 0) before the relayer gets to it.
    await mineAt(roundTime(2000000n) + 3600n);
    const rh = await sdk.refund(refunded.requestId);
    await publicClient.waitForTransactionReceipt({ hash: rh });

    const t = await relayer.tick();
    expect(t.fulfilled).toEqual([paying.requestId]);
    expect((await store.load())?.pending.size).toBe(0); // refunded id pruned, not re-read every tick
    expect((await sdk.getRequest(refunded.requestId)).status).toBe("refunded");

    const again = await relayer.tick();
    expect(again.due).toBe(0);
  });

  it("replaces a stuck tx with the same nonce instead of paying twice, and survives receipt timeouts", async () => {
    const round = (await publicClient.readContract({
      address: coordinator,
      abi: artifact("TestCoordinator.sol", "TestCoordinator").abi,
      functionName: "minRequestRound",
    })) as bigint;
    const req = await sdk.request({ round, bounty: 10_000n });
    await mineAt(roundTime(round) + 1n);

    const store = new MemoryStateStore();
    // Floor of 1 unit: the zero-bounty request left pending by the previous test is ignored.
    const relayer = makeRelayer({ store, minBounty: 1n, receiptTimeoutMs: 400 });
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });

    await rpc("evm_setAutomine", [false]);
    try {
      // Tick 1: sends, the receipt wait times out. Not an error: the inflight record is kept.
      const t1 = await relayer.tick();
      expect(t1.sent).toHaveLength(1);
      expect(t1.skipped).toContainEqual({ round, reason: "receipt_timeout" });
      const inflightOf = async () =>
        [...((await store.load())?.inflight.values() ?? [])].find((x) => x.round === round);
      const inflight = await inflightOf();
      expect(inflight?.txHash).toBe(t1.sent[0]);
      expect(inflight?.nonce).toBe(nonceBefore);

      // Tick 2 (before the timeout; relayer clock moved back): waits.
      clockOffsetMs = -10_000;
      const t2 = await relayer.tick();
      clockOffsetMs = 0;
      expect(t2.sent).toHaveLength(0);
      expect(t2.skipped).toContainEqual({ round, reason: "inflight" });

      // Tick 3 (after the timeout, tx still in the mempool): same-nonce replacement with higher fees.
      await sleep(450);
      const t3 = await relayer.tick();
      expect(t3.sent).toHaveLength(1);
      expect(t3.sent[0]).not.toBe(t1.sent[0]);
      const replaced = await inflightOf();
      expect(replaced?.nonce).toBe(nonceBefore);
      expect(replaced?.maxFeePerGas).toBeGreaterThan(inflight?.maxFeePerGas ?? 0n);
      expect(logs.some((l) => l.msg === "tx_replaced" && l.replacedTxHash === t1.sent[0])).toBe(true);
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    await rpc("evm_mine", []);

    // Exactly one tx landed.
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore + 1);
    expect((await sdk.getRequest(req.requestId)).status).toBe("fulfilled");

    const t4 = await relayer.tick();
    expect(t4.sent).toHaveLength(0);
    expect((await store.load())?.inflight.size).toBe(0);
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore + 1);
  });

  it("R1: fulfills a batch holding consumers that are cheap only in simulation, in one tx, without a revert loop", async () => {
    // Two callbacks that return early when tx.gasprice == 0 and burn 500k gas otherwise, plus an honest request.
    const evil = await deploy("Consumers.sol", "SimDivergentConsumer", [coordinator]);
    const evilAbi = artifact("Consumers.sol", "SimDivergentConsumer").abi;
    const head = await publicClient.getBlock({ blockTag: "latest" });
    const start = roundTime(roundAt(head.timestamp) + 2n); // two blocks inside one drand period pin the same round
    for (const dt of [0n, 1n]) {
      await rpc("evm_setNextBlockTimestamp", [Number(start + dt)]);
      const hash = await wallet.writeContract({
        address: evil,
        abi: evilAbi,
        functionName: "request",
        args: [500_000, 0n],
        account: requester,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    const count = (await publicClient.readContract({
      address: coordinator,
      abi: artifact("TestCoordinator.sol", "TestCoordinator").abi,
      functionName: "requestCount",
    })) as bigint;
    const evilIds = [count - 1n, count];
    const round = (await sdk.getRequest(count)).round;
    expect((await sdk.getRequest(count - 1n)).round).toBe(round);
    const honest = await sdk.request({ round, bounty: 10_000n });
    await mineAt(roundTime(round) + 1n);

    const store = new MemoryStateStore();
    const relayer = makeRelayer({ store, minBounty: 1n, sponsoredRequesters: [evil] });
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddr });
    const t = await relayer.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.reverted).toHaveLength(0);
    expect([...t.fulfilled].sort()).toEqual([...evilIds, honest.requestId].sort());
    const tx = await publicClient.getTransaction({ hash: t.sent[0] as `0x${string}` });
    expect(tx.gas).toBeGreaterThanOrEqual(1_000_000n + 2n * (500_000n / 63n));
    expect(logs.some((l) => l.msg === "simulation_fee_fields_rejected")).toBe(false);
    const fulfilled = logs.find((l) => l.msg === "fulfilled" && l.tickId === t.tickId);
    expect(fulfilled?.callbacksFailed).toEqual(evilIds.map(String));

    const again = await relayer.tick();
    expect(again.sent).toHaveLength(0);
    expect(await publicClient.getTransactionCount({ address: relayerAddr })).toBe(nonceBefore + 1);
  });
});
