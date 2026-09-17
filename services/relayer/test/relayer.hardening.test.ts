import {
  type ArcDrawClient,
  type ArcDrawRequest,
  arcDrawCoordinatorAbi,
  type LogChunk,
  roundTime,
  type SimulationFees,
  worstCaseFulfillBatchGas,
} from "@arcdraw/sdk";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Log,
  type PublicClient,
  pad,
  parseGwei,
  toHex,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { Relayer, type RelayerOptions } from "../src/relayer.js";
import { MemoryStateStore } from "../src/state.js";

const COORD: Address = "0x00000000000000000000000000000000A4Cd4A11";
const RELAYER: Address = "0x000000000000000000000000000000000000bEEF";
const EOA: Address = "0x000000000000000000000000000000000000A11c";
const SPONSORED: Address = "0x0000000000000000000000000000000000005005";
const ROUND = 5_000_000n;
const GAS_PRICE = parseGwei("20");
const fulfilledEvent = arcDrawCoordinatorAbi.find(
  (x) => x.type === "event" && x.name === "RandomnessFulfilled",
);

type Req = {
  requester: Address;
  round: bigint;
  callbackGasLimit: number;
  bounty: bigint;
  status: ArcDrawRequest["status"];
};
type Tx = {
  hash: Hash;
  nonce: number;
  gas: bigint;
  ids: bigint[];
  round: bigint;
  maxFeePerGas: bigint;
  mined: boolean;
};

/**
 * In-memory coordinator + node. `poison` ids make any batch containing them revert onchain (what a consumer that
 * behaves differently in simulation achieves against an estimate-based gas limit). `automine: false` leaves sent
 * transactions in the mempool so receipt waits time out.
 */
class FakeChain {
  requests = new Map<bigint, Req>();
  poison = new Set<bigint>();
  verified = new Set<bigint>();
  txs: Tx[] = [];
  simulations: { ids: bigint[]; fees: SimulationFees | undefined }[] = [];
  automine = true;
  timestamp = roundTime(ROUND) + 10n;
  private nonce = 0;

  add(id: bigint, r: Partial<Req> = {}) {
    this.requests.set(id, {
      requester: EOA,
      round: ROUND,
      callbackGasLimit: 0,
      bounty: 0n,
      status: "pending",
      ...r,
    });
  }

  latestNonce() {
    return this.txs.filter((t) => t.mined).reduce((n, t) => Math.max(n, t.nonce + 1), 0);
  }

  mine(tx: Tx) {
    // A replacement (same nonce) evicts the other mempool tx.
    this.txs = this.txs.filter((t) => t.mined || t.nonce !== tx.nonce || t === tx);
    tx.mined = true;
    if (tx.ids.some((id) => this.poison.has(id))) return;
    this.verified.add(tx.round);
    for (const id of tx.ids) {
      const r = this.requests.get(id);
      if (r && r.status !== "fulfilled") r.status = "fulfilled";
    }
  }

  /** Mines the newest tx per nonce (a replacement wins over the tx it replaced). */
  mineAll() {
    for (const t of [...this.txs].reverse()) if (!t.mined && this.txs.includes(t)) this.mine(t);
  }

  receipt(tx: Tx) {
    const success = !tx.ids.some((id) => this.poison.has(id));
    const logs = success
      ? tx.ids.map(
          (id) =>
            ({
              address: COORD,
              topics: encodeEventTopics({
                abi: [fulfilledEvent as NonNullable<typeof fulfilledEvent>],
                args: { requestId: id, round: tx.round, fulfiller: RELAYER },
              }),
              data: encodeAbiParameters(
                [{ type: "bytes32" }, { type: "uint96" }, { type: "bool" }],
                [pad(toHex(id)), this.requests.get(id)?.bounty ?? 0n, true],
              ),
              blockNumber: 2n,
              transactionHash: tx.hash,
              logIndex: 0,
              blockHash: pad("0x1"),
              transactionIndex: 0,
              removed: false,
            }) as unknown as Log,
        )
      : [];
    return {
      status: success ? "success" : "reverted",
      gasUsed: 100_000n,
      effectiveGasPrice: GAS_PRICE,
      blockNumber: 2n,
      logs,
      transactionHash: tx.hash,
    };
  }

  get client(): ArcDrawClient {
    const chain = this;
    return {
      coordinator: COORD,
      async *scanLogs(o: { fromBlock: bigint; toBlock?: bigint }): AsyncGenerator<LogChunk> {
        // Every request is in block 1.
        const requested =
          o.fromBlock > 1n
            ? []
            : [...chain.requests].map(([requestId, r]) => ({
                requestId,
                requester: r.requester,
                round: r.round,
                bounty: r.bounty,
                callbackGasLimit: r.callbackGasLimit,
                blockNumber: 1n,
                transactionHash: pad("0x2") as Hash,
              }));
        yield { fromBlock: o.fromBlock, toBlock: o.toBlock ?? 2n, requested, fulfilled: [] };
      },
      async getRequests(ids: readonly bigint[]) {
        return new Map(
          ids.map((id) => {
            const r = chain.requests.get(id);
            return [id, r && ({ id, createdAt: 0n, randomness: pad("0x0"), ...r } as ArcDrawRequest)];
          }),
        );
      },
      async getRoundRandomness(round: bigint) {
        return chain.verified.has(round) ? pad("0x1") : undefined;
      },
      async simulateFulfillBatch(_round: bigint, ids: readonly bigint[], o: { fees?: SimulationFees }) {
        chain.simulations.push({ ids: [...ids], fees: o.fees });
        return { gas: 300_000n + 35_000n * BigInt(ids.length), signature: "0x" };
      },
      async fulfillBatch(
        round: bigint,
        ids: readonly bigint[],
        o: { gas?: bigint; nonce?: number; maxFeePerGas?: bigint },
      ) {
        const nonce = o.nonce ?? chain.nonce++;
        const hash = pad(toHex(chain.txs.length + 1), { size: 32 }) as Hash;
        const tx: Tx = {
          hash,
          nonce,
          gas: o.gas ?? 0n,
          ids: [...ids],
          round,
          maxFeePerGas: o.maxFeePerGas ?? GAS_PRICE,
          mined: false,
        };
        chain.txs.push(tx);
        if (chain.automine) chain.mine(tx);
        return hash;
      },
    } as unknown as ArcDrawClient;
  }

  get publicClient(): PublicClient {
    const find = (hash: Hash) => this.txs.find((t) => t.hash === hash);
    return {
      getBlockNumber: async () => 2n,
      getBlock: async () => ({ number: 2n, timestamp: this.timestamp }),
      getGasPrice: async () => GAS_PRICE,
      getTransactionCount: async () => this.latestNonce(),
      getTransaction: async ({ hash }: { hash: Hash }) => {
        const t = find(hash);
        if (!t) throw new Error("not found");
        return { nonce: t.nonce, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: 1n };
      },
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const t = find(hash);
        if (!t?.mined) throw new Error("no receipt");
        return this.receipt(t);
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const t = find(hash);
        if (!t?.mined) throw new WaitForTransactionReceiptTimeoutError({ hash });
        return this.receipt(t);
      },
    } as unknown as PublicClient;
  }
}

function setup(chain: FakeChain, o: Partial<RelayerOptions> = {}) {
  let clock = 1_000_000;
  const logs: Record<string, unknown>[] = [];
  const store = new MemoryStateStore();
  const relayer = new Relayer({
    client: chain.client,
    publicClient: chain.publicClient,
    account: RELAYER,
    store,
    logger: createLogger({ level: "debug", write: (l) => logs.push(JSON.parse(l)) }),
    fetchBeacon: async (round) => ({ round, signature: "0x", randomness: "0x" }),
    chainId: 5042,
    dryRun: false,
    startBlock: 1n,
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    now: () => clock,
    ...o,
  });
  return {
    relayer,
    store,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("relayer hardening (in-memory chain)", () => {
  it("R1: bisects a batch that reverts onchain, fulfills the honest ids, quarantines then drops the hostile id", async () => {
    const chain = new FakeChain();
    for (let id = 1n; id <= 8n; id++) chain.add(id, { bounty: 50_000n });
    chain.add(3n, { bounty: 0n, callbackGasLimit: 500_000, requester: SPONSORED });
    chain.poison.add(3n);
    const { relayer, store, logs, advance } = setup(chain, {
      sponsoredRequesters: [SPONSORED],
      maxStrikes: 3,
      quarantineBaseMs: 30_000,
    });

    const sizes: number[][] = [];
    for (let i = 0; i < 12; i++) {
      const t = await relayer.tick();
      sizes.push(t.sent.map((h) => chain.txs.find((x) => x.hash === h)?.ids.length ?? 0));
      advance(120_000);
    }
    // 8 -> revert; 4 + 4 -> one reverts; 2 + 2 -> one reverts; 1 + 1 -> id 3 reverts alone; then strikes 2, 3 (dropped).
    expect(sizes.filter((s) => s.length > 0)).toEqual([[8], [4, 4], [2, 2], [1, 1], [1], [1]]);
    for (let id = 1n; id <= 8n; id++) {
      expect(chain.requests.get(id)?.status).toBe(id === 3n ? "pending" : "fulfilled");
    }
    const st = await store.load();
    expect(st?.pending.size).toBe(0);
    expect(st?.quarantine.size).toBe(0);
    expect(logs.some((l) => l.msg === "quarantine_dropped" && JSON.stringify(l.requestIds) === '["3"]')).toBe(
      true,
    );
    expect(relayer.metrics.txReverted).toBe(6);

    // Bounded: a dropped id is never sent again.
    const before = chain.txs.length;
    for (let i = 0; i < 3; i++) {
      await relayer.tick();
      advance(3_600_000);
    }
    expect(chain.txs.length).toBe(before);
  });

  it("R1: gas limit covers every callback at its full budget and simulation carries real fee fields", async () => {
    const chain = new FakeChain();
    chain.add(1n, { callbackGasLimit: 500_000, requester: SPONSORED });
    chain.add(2n, { callbackGasLimit: 500_000, requester: SPONSORED });
    chain.add(3n, { bounty: 50_000n });
    const { relayer } = setup(chain, { sponsoredRequesters: [SPONSORED] });
    const t = await relayer.tick();
    expect(t.sent).toHaveLength(1);
    const worst = worstCaseFulfillBatchGas({ freshRound: true, callbackGasLimits: [500_000, 500_000, 0] });
    expect(t.simulated[0]?.gas).toBeLessThan(worst);
    expect(t.simulated[0]?.gasLimit).toBe(worst);
    expect(chain.txs[0]?.gas).toBe(worst);
    expect(chain.simulations[0]?.fees).toEqual({ maxFeePerGas: GAS_PRICE, maxPriorityFeePerGas: 0n });
  });

  it("R1: a revert seen after a restart (inflight receipt) is bisected too, not blindly resent", async () => {
    const chain = new FakeChain();
    chain.add(1n, { bounty: 50_000n });
    chain.add(2n, { bounty: 50_000n });
    chain.poison.add(2n);
    chain.automine = false;
    const { relayer, advance } = setup(chain, { revertBackoffMs: 10_000 });
    const t1 = await relayer.tick();
    expect(t1.skipped).toContainEqual({ round: ROUND, reason: "receipt_timeout" });
    chain.mineAll();
    chain.automine = true;
    const t2 = await relayer.tick();
    expect(t2.reverted).toHaveLength(1);
    expect(t2.sent).toHaveLength(0); // backed off
    advance(10_001);
    const t3 = await relayer.tick();
    expect(t3.sent).toHaveLength(2); // halves
    expect(chain.requests.get(1n)?.status).toBe("fulfilled");
  });

  it("L3: tracks inflight per transaction, so batches of one round never replace each other's nonce", async () => {
    const chain = new FakeChain();
    for (let id = 1n; id <= 4n; id++) chain.add(id, { bounty: 50_000n });
    chain.automine = false;
    const { relayer, store, advance } = setup(chain, { maxBatch: 2, receiptTimeoutMs: 1_000 });

    const t1 = await relayer.tick();
    expect(t1.sent).toHaveLength(2);
    const st1 = await store.load();
    const records = [...(st1?.inflight.values() ?? [])];
    expect(records.map((r) => [r.nonce, r.requestIds])).toEqual([
      [0, [1n, 2n]],
      [1, [3n, 4n]],
    ]);

    // Before the timeout: both batches wait, nothing is resent.
    const t2 = await relayer.tick();
    expect(t2.sent).toHaveLength(0);
    expect(t2.skipped.filter((s) => s.reason === "inflight")).toHaveLength(2);

    // After the timeout: each stuck tx is replaced with its own nonce and its own ids.
    advance(1_001);
    const t3 = await relayer.tick();
    expect(t3.sent).toHaveLength(2);
    const replaced = t3.sent.map((h) => chain.txs.find((x) => x.hash === h));
    expect(replaced.map((x) => [x?.nonce, x?.ids])).toEqual([
      [0, [1n, 2n]],
      [1, [3n, 4n]],
    ]);
    expect(replaced.every((x) => (x?.maxFeePerGas ?? 0n) > GAS_PRICE)).toBe(true);
    expect((await store.load())?.inflight.size).toBe(2);

    chain.mineAll();
    await relayer.tick();
    expect([...chain.requests.values()].every((r) => r.status === "fulfilled")).toBe(true);
    expect(chain.txs.filter((t) => t.mined)).toHaveLength(2); // one tx landed per nonce
    const st = await store.load();
    expect(st?.inflight.size).toBe(0);
    expect(st?.pending.size).toBe(0);
  });

  it("R2: sends only batches whose bounties cover the worst-case cost; sponsors and the callback gas cap apply", async () => {
    const chain = new FakeChain();
    chain.add(1n, { bounty: 500n }); // pays less than its own share
    chain.add(6n, { bounty: 0n }); // zero bounty: never tracked while the gate is on
    chain.add(2n, { bounty: 20_000n }); // pays for itself and the round
    chain.add(3n, { bounty: 0n, callbackGasLimit: 100_000, requester: SPONSORED }); // operator-sponsored
    chain.add(4n, { bounty: 1_000n, callbackGasLimit: 200_000 }); // too cheap for its callback budget
    chain.add(5n, { bounty: 1_000_000n, callbackGasLimit: 300_000 }); // above RELAYER_MAX_CALLBACK_GAS
    const { relayer, logs, advance } = setup(chain, {
      sponsoredRequesters: [SPONSORED],
      maxCallbackGas: 200_000,
      unprofitableRetryMs: 60_000,
    });
    const t = await relayer.tick();
    expect(t.sent).toHaveLength(1);
    expect(chain.txs[0]?.ids).toEqual([2n, 3n]);
    expect(logs.some((l) => l.msg === "skip_below_floor" && JSON.stringify(l.requestIds) === '["6"]')).toBe(
      true,
    );
    expect(
      logs.some((l) => l.msg === "skip_callback_gas_cap" && JSON.stringify(l.requestIds) === '["5"]'),
    ).toBe(true);
    expect(
      logs.some((l) => l.msg === "skip_unprofitable" && JSON.stringify(l.requestIds) === '["1","4"]'),
    ).toBe(true);

    // Deferred, not re-simulated every tick.
    const sims = chain.simulations.length;
    const again = await relayer.tick();
    expect(again.due).toBe(0);
    expect(chain.simulations.length).toBe(sims);
    advance(60_001);
    const later = await relayer.tick();
    expect(later.due).toBe(2);
    expect(later.sent).toHaveLength(0);
  });

  it("R2: a bounty that covers its own share but not the round's BLS verification is not sent alone", async () => {
    const chain = new FakeChain();
    chain.add(1n, { bounty: 2_000n });
    const { relayer } = setup(chain);
    const t = await relayer.tick();
    expect(t.sent).toHaveLength(0);
    expect(t.skipped).toContainEqual({ round: ROUND, reason: "unprofitable" });

    // With RELAYER_COST_MARGIN_PCT=0 (sponsor everything) the same request is sent right away.
    const sponsorAll = setup(chain, { costMarginPct: 0 });
    const t2 = await sponsorAll.relayer.tick();
    expect(t2.sent).toHaveLength(1);
  });
});
