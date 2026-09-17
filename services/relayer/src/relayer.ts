import { randomUUID } from "node:crypto";
import {
  type ArcDrawClient,
  arcDrawCoordinatorAbi,
  type Beacon,
  ContractRevertError,
  DrandFetchError,
  InvalidBeaconError,
  roundTime,
} from "@arcdraw/sdk";
import { type Account, type Address, formatUnits, type Hash, type PublicClient, parseEventLogs } from "viem";
import type { Logger } from "./logger.js";
import { withRetry } from "./retry.js";
import { emptyState, type RelayerState, type StateStore } from "./state.js";

export type RelayerOptions = {
  client: ArcDrawClient;
  publicClient: PublicClient;
  /** Sender for simulation and transactions. */
  account: Account | Address;
  store: StateStore;
  logger: Logger;
  fetchBeacon: (round: bigint, signal?: AbortSignal) => Promise<Beacon>;
  chainId: number;
  dryRun: boolean;
  startBlock?: bigint | undefined;
  minBounty?: bigint;
  maxGasPrice?: bigint;
  maxBatch?: number;
  gasBufferPct?: number;
  receiptTimeoutMs?: number;
  scanChunk?: bigint;
  /** Retry tuning (tests shorten these). */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  now?: () => number;
};

export type TickResult = {
  tickId: string;
  head: bigint;
  scannedTo: bigint;
  due: number;
  sent: Hash[];
  simulated: { round: bigint; requestIds: bigint[]; gas: bigint }[];
  fulfilled: bigint[];
  skipped: { round: bigint; reason: string }[];
};

export type RelayerMetrics = {
  ticks: number;
  fulfilledTotal: number;
  txSent: number;
  txReverted: number;
  lastTickAt: number | undefined;
  lastScannedBlock: bigint;
  pending: number;
};

const isRpcRetryable = (err: unknown) => !(err instanceof ContractRevertError);

/**
 * The relayer loop body. One `tick()`:
 * 1. scans coordinator logs from the cursor to head in <= 10k-block windows (cursor persisted per window);
 * 2. picks pending requests whose round is due at the head block timestamp;
 * 3. per round: re-reads statuses onchain, fetches + verifies the beacon, simulates `fulfillBatch`,
 *    then sends (or, in dry-run, only logs the simulation) and waits for the receipt.
 * Every log line of a tick carries `tickId`; per-round lines add `round` and `requestIds`.
 */
export class Relayer {
  private state: RelayerState | undefined;
  private readonly now: () => number;
  private readonly dryRunLogged = new Set<string>();
  readonly metrics: RelayerMetrics = {
    ticks: 0,
    fulfilledTotal: 0,
    txSent: 0,
    txReverted: 0,
    lastTickAt: undefined,
    lastScannedBlock: -1n,
    pending: 0,
  };

  constructor(private readonly o: RelayerOptions) {
    this.now = o.now ?? Date.now;
  }

  private get accountAddress(): Address {
    return typeof this.o.account === "string" ? this.o.account : this.o.account.address;
  }

  async init(): Promise<RelayerState> {
    if (this.state) return this.state;
    const loaded = await this.o.store.load();
    const coordinator = this.o.client.coordinator;
    if (
      loaded &&
      (loaded.chainId !== this.o.chainId || loaded.coordinator.toLowerCase() !== coordinator.toLowerCase())
    ) {
      throw new Error(
        `state file belongs to chain ${loaded.chainId} / ${loaded.coordinator}, not ${this.o.chainId} / ${coordinator}; use another RELAYER_STATE_FILE`,
      );
    }
    this.state = loaded ?? emptyState(this.o.chainId, coordinator);
    this.syncMetrics();
    return this.state;
  }

  private syncMetrics() {
    if (!this.state) return;
    this.metrics.lastScannedBlock = this.state.lastScannedBlock;
    this.metrics.pending = this.state.pending.size;
  }

  private async persist() {
    if (this.state) await this.o.store.save(this.state);
    this.syncMetrics();
  }

  private rpc<T>(log: Logger, what: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withRetry(fn, {
      attempts: this.o.retry?.attempts ?? 4,
      baseDelayMs: this.o.retry?.baseDelayMs ?? 250,
      maxDelayMs: this.o.retry?.maxDelayMs ?? 5_000,
      shouldRetry: isRpcRetryable,
      onRetry: (err, attempt, delayMs) => log.warn("rpc_retry", { what, attempt, delayMs, err }),
      signal,
    });
  }

  async tick(signal?: AbortSignal): Promise<TickResult> {
    const state = await this.init();
    const tickId = randomUUID().slice(0, 8);
    const log = this.o.logger.child({ tickId });
    const started = this.now();
    const result: TickResult = {
      tickId,
      head: 0n,
      scannedTo: state.lastScannedBlock,
      due: 0,
      sent: [],
      simulated: [],
      fulfilled: [],
      skipped: [],
    };
    const { client, publicClient } = this.o;

    // 1. scan
    const head = await this.rpc(
      log,
      "getBlockNumber",
      () => publicClient.getBlockNumber({ cacheTime: 0 }),
      signal,
    );
    result.head = head;
    if (state.lastScannedBlock < 0n) {
      state.lastScannedBlock = (this.o.startBlock ?? head) - 1n;
      log.info("cursor_initialized", { fromBlock: state.lastScannedBlock + 1n });
    }
    const chunkSize = this.o.scanChunk ?? 10_000n;
    while (state.lastScannedBlock < head) {
      signal?.throwIfAborted();
      const fromBlock = state.lastScannedBlock + 1n;
      const toBlock = fromBlock + chunkSize - 1n < head ? fromBlock + chunkSize - 1n : head;
      const c = await this.rpc(
        log,
        "getLogs",
        async () => {
          for await (const chunk of client.scanLogs({ fromBlock, toBlock, chunkSize })) return chunk;
          throw new Error("empty scan window");
        },
        signal,
      );
      for (const r of c.requested) state.pending.set(r.requestId, { round: r.round, bounty: r.bounty });
      for (const f of c.fulfilled) state.pending.delete(f.requestId);
      state.lastScannedBlock = c.toBlock;
      await this.persist();
      if (c.requested.length || c.fulfilled.length) {
        log.info("logs_scanned", {
          fromBlock: c.fromBlock,
          toBlock: c.toBlock,
          requested: c.requested.map((r) => r.requestId),
          fulfilled: c.fulfilled.map((f) => f.requestId),
        });
      }
    }
    result.scannedTo = state.lastScannedBlock;

    // 2. due requests, by the chain's clock (the contract checks block.timestamp >= roundTimestamp)
    const block = await this.rpc(log, "getBlock", () => publicClient.getBlock({ blockNumber: head }), signal);
    const byRound = new Map<bigint, bigint[]>();
    for (const [id, p] of state.pending) {
      if (roundTime(p.round) > block.timestamp) continue;
      const ids = byRound.get(p.round) ?? [];
      ids.push(id);
      byRound.set(p.round, ids);
    }
    const rounds = [...byRound.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    result.due = [...byRound.values()].reduce((n, ids) => n + ids.length, 0);

    // 3. fulfill per round
    for (const round of rounds) {
      if (signal?.aborted) break;
      const ids = (byRound.get(round) ?? []).sort((a, b) => (a < b ? -1 : 1));
      const maxBatch = this.o.maxBatch ?? 20;
      for (let i = 0; i < ids.length; i += maxBatch) {
        if (signal?.aborted) break;
        await this.processRound(round, ids.slice(i, i + maxBatch), log.child({ round }), result, signal);
      }
    }

    this.metrics.ticks++;
    this.metrics.lastTickAt = this.now();
    this.syncMetrics();
    log.debug("tick_done", {
      head,
      due: result.due,
      sent: result.sent.length,
      pending: state.pending.size,
      durationMs: this.now() - started,
    });
    return result;
  }

  private async processRound(
    round: bigint,
    candidateIds: bigint[],
    log: Logger,
    result: TickResult,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.state as RelayerState;
    const { client, publicClient } = this.o;
    const skip = (
      reason: string,
      level: "debug" | "info" | "warn" | "error",
      fields: Record<string, unknown> = {},
    ) => {
      result.skipped.push({ round, reason });
      log[level](`skip_${reason}`, { requestIds: candidateIds, ...fields });
    };

    // a. a batch for this round already sent (maybe by a previous process): settle it first
    const inflight = state.inflight.get(round);
    if (inflight) {
      const receipt = await publicClient
        .getTransactionReceipt({ hash: inflight.txHash })
        .catch(() => undefined);
      if (receipt) {
        log.info("inflight_confirmed", {
          txHash: inflight.txHash,
          status: receipt.status,
          requestIds: inflight.requestIds,
        });
        state.inflight.delete(round);
        await this.persist();
      } else if (this.now() - inflight.sentAt < (this.o.receiptTimeoutMs ?? 60_000)) {
        return skip("inflight", "debug", { txHash: inflight.txHash });
      } else {
        log.warn("inflight_dropped", { txHash: inflight.txHash, requestIds: inflight.requestIds });
        state.inflight.delete(round);
        await this.persist();
      }
    }

    // b. onchain truth: drop fulfilled/unknown ids, apply the bounty floor
    const statuses = await this.rpc(log, "getRequests", () => client.getRequests(candidateIds), signal);
    const ids: bigint[] = [];
    const withCallback = new Set<bigint>();
    for (const id of candidateIds) {
      const r = statuses.get(id);
      if (!r || r.status === "fulfilled" || r.status === "none") {
        state.pending.delete(id);
        continue;
      }
      const bounty = r.status === "pending" ? r.bounty : 0n;
      if (bounty < (this.o.minBounty ?? 0n)) continue;
      ids.push(id);
      if (r.callbackGasLimit > 0) withCallback.add(id);
    }
    await this.persist();
    if (ids.length === 0) return;
    log = log.child({ requestIds: ids });

    // c. beacon (skipped when the round is already verified onchain)
    let beacon: Beacon | undefined;
    const verified = await this.rpc(log, "roundRandomness", () => client.getRoundRandomness(round), signal);
    if (!verified) {
      try {
        const t0 = this.now();
        beacon = await withRetry(() => this.o.fetchBeacon(round, signal), {
          attempts: this.o.retry?.attempts ?? 4,
          baseDelayMs: this.o.retry?.baseDelayMs ?? 500,
          maxDelayMs: this.o.retry?.maxDelayMs ?? 30_000,
          shouldRetry: (err) => err instanceof DrandFetchError,
          onRetry: (err, attempt, delayMs) => log.warn("drand_retry", { attempt, delayMs, err }),
          signal,
        });
        log.debug("beacon_fetched", { latencyMs: this.now() - t0, randomness: beacon.randomness });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof InvalidBeaconError) return skip("invalid_beacon", "error", { err });
        return skip("drand_unavailable", "warn", { err });
      }
    }

    // d. gas price ceiling
    const gasPrice = await this.rpc(log, "getGasPrice", () => publicClient.getGasPrice(), signal);
    if (this.o.maxGasPrice !== undefined && gasPrice > this.o.maxGasPrice) {
      return skip("gas_price_too_high", "warn", { gasPrice, maxGasPrice: this.o.maxGasPrice });
    }

    // e. simulate (eth_call + eth_estimateGas)
    let gas: bigint;
    try {
      ({ gas } = await this.rpc(
        log,
        "simulateFulfillBatch",
        () =>
          client.simulateFulfillBatch(round, ids, {
            account: this.o.account,
            ...(beacon ? { beacon } : {}),
          }),
        signal,
      ));
    } catch (err) {
      if (err instanceof ContractRevertError) {
        const level = err.errorName === "RoundNotReached" ? "info" : "error";
        return skip("simulation_reverted", level, { errorName: err.errorName, err });
      }
      throw err;
    }
    result.simulated.push({ round, requestIds: ids, gas });
    const costUsdc = formatUnits(gas * gasPrice, 18);

    if (this.o.dryRun) {
      const key = `${round}:${ids.join(",")}`;
      const first = !this.dryRunLogged.has(key);
      this.dryRunLogged.add(key);
      log[first ? "info" : "debug"]("dry_run_would_fulfill", {
        gas,
        gasPrice,
        estCostUsdc: costUsdc,
        from: this.accountAddress,
        batchSize: ids.length,
      });
      return;
    }

    // f. send, record inflight before waiting, then settle
    const gasLimit = gas + (gas * BigInt(this.o.gasBufferPct ?? 20)) / 100n;
    let hash: Hash;
    try {
      hash = await client.fulfillBatch(round, ids, {
        gas: gasLimit,
        account: this.o.account,
        ...(beacon ? { beacon } : {}),
      });
    } catch (err) {
      if (err instanceof ContractRevertError) {
        return skip("send_reverted", err.errorName === "RequestNotFulfillable" ? "info" : "error", {
          errorName: err.errorName,
          err,
        });
      }
      throw err;
    }
    this.metrics.txSent++;
    result.sent.push(hash);
    state.inflight.set(round, { txHash: hash, requestIds: ids, sentAt: this.now() });
    await this.persist();
    log.info("tx_sent", { txHash: hash, gasLimit, estCostUsdc: costUsdc, batchSize: ids.length });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: this.o.receiptTimeoutMs ?? 60_000,
    });
    state.inflight.delete(round);
    if (receipt.status !== "success") {
      this.metrics.txReverted++;
      await this.persist();
      log.error("tx_reverted", { txHash: hash, gasUsed: receipt.gasUsed });
      return;
    }
    const events = parseEventLogs({
      abi: arcDrawCoordinatorAbi,
      logs: receipt.logs,
      eventName: "RandomnessFulfilled",
    });
    const fulfilled = events.map((e) => e.args.requestId);
    for (const id of fulfilled) state.pending.delete(id);
    await this.persist();
    const minedBlock = await publicClient
      .getBlock({ blockNumber: receipt.blockNumber })
      .catch(() => undefined);
    this.metrics.fulfilledTotal += fulfilled.length;
    result.fulfilled.push(...fulfilled);
    log.info("fulfilled", {
      txHash: hash,
      gasUsed: receipt.gasUsed,
      costUsdc: formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
      batch_size: fulfilled.length,
      fulfilled_total: this.metrics.fulfilledTotal,
      // callbackSuccess is also false when no callback ran (EOA requester or callbackGasLimit 0).
      callbacksFailed: events
        .filter((e) => withCallback.has(e.args.requestId) && !e.args.callbackSuccess)
        .map((e) => e.args.requestId),
      bountyPaid: events.reduce((s, e) => s + e.args.bountyPaid, 0n),
      latency_ms: minedBlock ? Number(minedBlock.timestamp - roundTime(round)) * 1000 : undefined,
    });
  }
}
