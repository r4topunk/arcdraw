import { randomUUID } from "node:crypto";
import {
  type ArcDrawClient,
  arcDrawCoordinatorAbi,
  type Beacon,
  ContractRevertError,
  callbackGasReserve,
  DrandFetchError,
  FULFILL_GAS,
  gasCostUsdc,
  InvalidBeaconError,
  roundTime,
  worstCaseFulfillBatchGas,
} from "@arcdraw/sdk";
import {
  type Account,
  type Address,
  formatUnits,
  type Hash,
  type PublicClient,
  parseEventLogs,
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import type { Logger } from "./logger.js";
import { withRetry } from "./retry.js";
import { emptyState, type InflightTx, type RelayerState, type StateStore } from "./state.js";

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
  /** Stop starting new batches once a tick has run this long; the rest waits for the next tick. Default 30s. */
  maxTickMs?: number;
  /** Fee bump (percent) when replacing a stuck tx with the same nonce. Default 25. */
  replaceBumpPct?: number;
  scanChunk?: bigint;
  /**
   * Profitability gate: a batch is sent only if its bounties cover `costMarginPct`% of its worst-case gas cost
   * (`worstCaseFulfillBatchGas` at the current gas price). 0 disables the gate. Default 120.
   */
  costMarginPct?: number;
  /** Requesters relayed regardless of bounty (for example the operator's own demo contracts). */
  sponsoredRequesters?: readonly Address[];
  /** Largest `callbackGasLimit` this relayer pays for; requests above it are left to others. Default 500,000. */
  maxCallbackGas?: number;
  /** Wait before retrying the ids of a batch that reverted onchain (split in halves). Default 5s. */
  revertBackoffMs?: number;
  /** Quarantine of a single id whose tx reverted onchain: doubles per strike from base, capped. Default 30s / 1h. */
  quarantineBaseMs?: number;
  quarantineMaxMs?: number;
  /** Single-id onchain reverts after which the id is dropped for good. Default 6. */
  maxStrikes?: number;
  /** Re-check interval for requests that do not pay for their gas at the current price. Default 60s. */
  unprofitableRetryMs?: number;
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
  simulated: { round: bigint; requestIds: bigint[]; gas: bigint; gasLimit: bigint }[];
  fulfilled: bigint[];
  reverted: { round: bigint; requestIds: bigint[]; txHash: Hash }[];
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
  quarantined: number;
};

const isRpcRetryable = (err: unknown) => !(err instanceof ContractRevertError);

const maxOf = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));

/**
 * The relayer loop body. One `tick()`:
 * 1. scans coordinator logs from the cursor to head in <= 10k-block windows (cursor persisted per window);
 * 2. settles sent transactions (confirmed, reverted, dropped or due for a same-nonce replacement);
 * 3. picks pending requests whose round is due at the head block timestamp, minus ids that are in flight or backed
 *    off, and splits them into batches;
 * 4. per batch: re-reads statuses onchain, applies the bounty / callback-gas / profitability gates, fetches and
 *    verifies the beacon, simulates `fulfillBatch`, then sends with a worst-case gas limit (or, in dry-run, only
 *    logs the simulation) and waits for the receipt.
 * A batch that reverts onchain is bisected on the next ticks; an id that reverts alone is quarantined with
 * exponential backoff and eventually dropped, so one hostile consumer cannot make the relayer resend forever.
 * Every log line of a tick carries `tickId`; per-batch lines add `round` and `requestIds`.
 */
export class Relayer {
  private state: RelayerState | undefined;
  private readonly now: () => number;
  private readonly dryRunLogged = new Set<string>();
  private readonly sponsored: Set<string>;
  readonly metrics: RelayerMetrics = {
    ticks: 0,
    fulfilledTotal: 0,
    txSent: 0,
    txReverted: 0,
    lastTickAt: undefined,
    lastScannedBlock: -1n,
    pending: 0,
    quarantined: 0,
  };

  constructor(private readonly o: RelayerOptions) {
    this.now = o.now ?? Date.now;
    this.sponsored = new Set((o.sponsoredRequesters ?? []).map((a) => a.toLowerCase()));
  }

  /**
   * Smallest bounty worth tracking for a non-sponsored request. With the profitability gate on, a zero bounty can never
   * pay for gas, so zero-bounty spam is not tracked (and not re-read every minute).
   */
  private get bountyFloor(): bigint {
    const min = this.o.minBounty ?? 0n;
    return (this.o.costMarginPct ?? 120) > 0 && min < 1n ? 1n : min;
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
    this.metrics.quarantined = [...this.state.quarantine.values()].filter((q) => q.strikes > 0).length;
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
      reverted: [],
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
      const minBounty = this.bountyFloor;
      const maxCallbackGas = this.o.maxCallbackGas ?? 500_000;
      const belowFloor: bigint[] = [];
      const overGasCap: bigint[] = [];
      for (const r of c.requested) {
        const sponsored = this.sponsored.has(r.requester.toLowerCase());
        // A bounty never increases after the request (a refund only lowers it to 0), so a request below the floor
        // stays below it: do not track it at all. Same for a callback budget above what this relayer pays for.
        if (r.callbackGasLimit > maxCallbackGas) overGasCap.push(r.requestId);
        else if (!sponsored && r.bounty < minBounty) belowFloor.push(r.requestId);
        else state.pending.set(r.requestId, { round: r.round, bounty: r.bounty });
      }
      if (belowFloor.length) log.info("skip_below_floor", { requestIds: belowFloor, minBounty });
      if (overGasCap.length) log.info("skip_callback_gas_cap", { requestIds: overGasCap, maxCallbackGas });
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

    // 2. settle sent transactions; ids in unconfirmed ones are busy
    const { busy, replacements } = await this.settleInflight(log, result, signal);

    // 3. due requests, by the chain's clock (the contract checks block.timestamp >= roundTimestamp)
    const block = await this.rpc(log, "getBlock", () => publicClient.getBlock({ blockNumber: head }), signal);
    const now = this.now();
    for (const id of state.quarantine.keys()) if (!state.pending.has(id)) state.quarantine.delete(id);
    const byRound = new Map<bigint, bigint[]>();
    const backedOff: bigint[] = [];
    for (const [id, p] of state.pending) {
      if (roundTime(p.round) > block.timestamp || busy.has(id)) continue;
      if ((state.quarantine.get(id)?.notBefore ?? 0) > now) {
        backedOff.push(id);
        continue;
      }
      const ids = byRound.get(p.round) ?? [];
      ids.push(id);
      byRound.set(p.round, ids);
    }
    if (backedOff.length) log.debug("skip_backoff", { requestIds: backedOff });

    // Best-paying rounds first (bounty as recorded at request time), then oldest round.
    const roundBounty = (round: bigint) =>
      (byRound.get(round) ?? []).reduce((sum, id) => sum + (state.pending.get(id)?.bounty ?? 0n), 0n);
    const rounds = [...byRound.keys()].sort((a, b) => {
      const ba = roundBounty(a);
      const bb = roundBounty(b);
      if (ba !== bb) return ba > bb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    result.due = [...byRound.values()].reduce((n, ids) => n + ids.length, 0);

    // 4. replacements of stuck txs first, then new batches, within the tick time budget
    const maxTickMs = this.o.maxTickMs ?? 30_000;
    let budgetExhausted = false;
    const canStart = (round: bigint) => {
      if (signal?.aborted || budgetExhausted) return false;
      if (this.now() - started <= maxTickMs) return true;
      budgetExhausted = true;
      log.warn("tick_budget_exhausted", { maxTickMs, deferredRound: round });
      return false;
    };
    for (const r of replacements) {
      if (!canStart(r.tx.round)) break;
      await this.processBatch(
        r.tx.round,
        r.tx.requestIds,
        log.child({ round: r.tx.round }),
        result,
        signal,
        r,
      );
    }
    for (const round of rounds) {
      if (signal?.aborted || budgetExhausted) break;
      for (const batch of this.makeBatches(byRound.get(round) ?? [])) {
        if (!canStart(round)) break;
        await this.processBatch(round, batch, log.child({ round }), result, signal);
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

  /**
   * Batches for one round. Ids that were in a batch that reverted onchain carry `maxGroup` (half of that batch) and
   * are only sent in groups of at most that size, apart from untouched ids: a revert bisects down to the id causing it.
   */
  private makeBatches(ids: bigint[]): bigint[][] {
    const state = this.state as RelayerState;
    const maxBatch = this.o.maxBatch ?? 20;
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : 1));
    const group = (id: bigint) => state.quarantine.get(id)?.maxGroup;
    const normal = sorted.filter((id) => group(id) === undefined);
    const suspects = sorted
      .filter((id) => group(id) !== undefined)
      .sort((a, b) => (group(a) as number) - (group(b) as number) || (a < b ? -1 : 1));
    const batches: bigint[][] = [];
    for (let i = 0; i < normal.length; i += maxBatch) batches.push(normal.slice(i, i + maxBatch));
    for (let i = 0; i < suspects.length; ) {
      const size = Math.max(1, Math.min(group(suspects[i] as bigint) as number, maxBatch));
      batches.push(suspects.slice(i, i + size));
      i += size;
    }
    return batches;
  }

  /** Confirm, drop or schedule replacement of every recorded transaction. Returns ids still in flight. */
  private async settleInflight(
    log: Logger,
    result: TickResult,
    signal?: AbortSignal,
  ): Promise<{ busy: Set<bigint>; replacements: { tx: InflightTx; gasFloor: bigint }[] }> {
    const state = this.state as RelayerState;
    const { publicClient } = this.o;
    const busy = new Set<bigint>();
    const replacements: { tx: InflightTx; gasFloor: bigint }[] = [];
    if (state.inflight.size === 0) return { busy, replacements };

    let latestNonce: number | undefined;
    const getLatestNonce = async () => {
      latestNonce ??= await this.rpc(
        log,
        "getTransactionCount",
        () => publicClient.getTransactionCount({ address: this.accountAddress, blockTag: "latest" }),
        signal,
      );
      return latestNonce;
    };

    for (const t of [...state.inflight.values()]) {
      const tlog = log.child({ round: t.round, requestIds: t.requestIds, txHash: t.txHash });
      const receipt = await publicClient.getTransactionReceipt({ hash: t.txHash }).catch(() => undefined);
      if (receipt) {
        state.inflight.delete(t.txHash);
        tlog.info("inflight_confirmed", { status: receipt.status });
        await this.onReceipt(t, receipt, tlog, result);
        continue;
      }
      const stillPending = t.requestIds.some((id) => state.pending.has(id));
      const nonceUsed = t.nonce !== undefined && (await getLatestNonce()) > t.nonce;
      if (!stillPending) {
        // Settled elsewhere (seen by the scan): forget the record once its nonce is used.
        if (nonceUsed || t.nonce === undefined) {
          state.inflight.delete(t.txHash);
          tlog.info("inflight_settled", { mined: false });
        }
        continue;
      }
      if (this.now() - t.sentAt < (this.o.receiptTimeoutMs ?? 60_000)) {
        for (const id of t.requestIds) busy.add(id);
        result.skipped.push({ round: t.round, reason: "inflight" });
        tlog.debug("skip_inflight");
        continue;
      }
      // Timed out without a receipt. Never blindly send a second tx with a fresh nonce: if the first one is
      // still in the mempool, both could land and the relayer would pay gas twice.
      const stillKnown = nonceUsed
        ? undefined // nonce already used by another tx (e.g. an earlier replacement): this hash can never land
        : await publicClient.getTransaction({ hash: t.txHash }).catch(() => undefined);
      if (stillKnown && t.nonce !== undefined) {
        tlog.warn("inflight_replacing", { nonce: t.nonce });
        for (const id of t.requestIds) busy.add(id);
        // Estimates may run against pending state that already includes the stuck tx (round verified, ids
        // settled) and come out too low; never go below the gas limit of the tx being replaced.
        replacements.push({ tx: t, gasFloor: stillKnown.gas });
      } else if (stillKnown) {
        for (const id of t.requestIds) busy.add(id);
        result.skipped.push({ round: t.round, reason: "inflight" });
        tlog.warn("skip_inflight", { note: "pending in mempool, nonce unknown" });
      } else {
        tlog.warn("inflight_dropped", { latestNonce });
        state.inflight.delete(t.txHash);
      }
    }
    await this.persist();
    return { busy, replacements };
  }

  /** Apply a mined receipt: fulfilled ids leave the pending set; a revert bisects or quarantines the batch. */
  private async onReceipt(t: InflightTx, receipt: TransactionReceipt, log: Logger, result: TickResult) {
    const state = this.state as RelayerState;
    if (receipt.status !== "success") {
      this.onBatchReverted(t, log, result, receipt.gasUsed);
      await this.persist();
      return;
    }
    const events = parseEventLogs({
      abi: arcDrawCoordinatorAbi,
      logs: receipt.logs,
      eventName: "RandomnessFulfilled",
    });
    const fulfilled = events.map((e) => e.args.requestId);
    for (const id of t.requestIds) state.pending.delete(id); // skipped ids were settled by someone else
    for (const id of t.requestIds) state.quarantine.delete(id);
    await this.persist();
    this.metrics.fulfilledTotal += fulfilled.length;
    result.fulfilled.push(...fulfilled);
    return events;
  }

  /**
   * An onchain revert costs gas, so the same batch is never simply resent. A multi-id batch is split in halves
   * after a short backoff (bisection); a single id is quarantined with exponential backoff and dropped after
   * `maxStrikes`. Honest ids that shared a batch with a hostile one are fulfilled by the half without it.
   */
  private onBatchReverted(t: InflightTx, log: Logger, result: TickResult, gasUsed: bigint) {
    const state = this.state as RelayerState;
    const now = this.now();
    this.metrics.txReverted++;
    result.reverted.push({ round: t.round, requestIds: t.requestIds, txHash: t.txHash });
    const ids = t.requestIds.filter((id) => state.pending.has(id));
    if (ids.length > 1) {
      const group = Math.ceil(ids.length / 2);
      const notBefore = now + (this.o.revertBackoffMs ?? 5_000);
      for (const id of ids) {
        const q = state.quarantine.get(id) ?? { strikes: 0, notBefore: 0 };
        state.quarantine.set(id, {
          ...q,
          maxGroup: Math.min(q.maxGroup ?? group, group),
          notBefore: Math.max(q.notBefore, notBefore),
        });
      }
      log.error("tx_reverted", { txHash: t.txHash, gasUsed, action: "bisect", nextBatchSize: group });
      return;
    }
    for (const id of ids) {
      const q = state.quarantine.get(id) ?? { strikes: 0, notBefore: 0 };
      const strikes = q.strikes + 1;
      if (strikes >= (this.o.maxStrikes ?? 6)) {
        state.pending.delete(id);
        state.quarantine.delete(id);
        log.error("quarantine_dropped", { txHash: t.txHash, gasUsed, requestIds: [id], strikes });
        continue;
      }
      const base = this.o.quarantineBaseMs ?? 30_000;
      const delay = Math.min(base * 2 ** (strikes - 1), this.o.quarantineMaxMs ?? 3_600_000);
      state.quarantine.set(id, { strikes, maxGroup: 1, notBefore: now + delay });
      log.error("tx_reverted", {
        txHash: t.txHash,
        gasUsed,
        action: "quarantine",
        requestIds: [id],
        strikes,
        retryInMs: delay,
      });
    }
  }

  /** Push back ids that do not pay for their gas right now (bisection and strike data are kept). */
  private defer(ids: readonly bigint[], ms: number) {
    const state = this.state as RelayerState;
    const notBefore = this.now() + ms;
    for (const id of ids) {
      const q = state.quarantine.get(id) ?? { strikes: 0, notBefore: 0 };
      state.quarantine.set(id, { ...q, notBefore: Math.max(q.notBefore, notBefore) });
    }
  }

  private async processBatch(
    round: bigint,
    candidateIds: bigint[],
    log: Logger,
    result: TickResult,
    signal?: AbortSignal,
    replacing?: { tx: InflightTx; gasFloor: bigint },
  ): Promise<void> {
    const state = this.state as RelayerState;
    const { client, publicClient } = this.o;
    const replace = replacing?.tx;
    const skip = (
      reason: string,
      level: "debug" | "info" | "warn" | "error",
      fields: Record<string, unknown> = {},
    ) => {
      result.skipped.push({ round, reason });
      log[level](`skip_${reason}`, { requestIds: candidateIds, ...fields });
    };

    // a. onchain truth: drop fulfilled/unknown ids, apply the bounty floor and the callback gas cap
    const statuses = await this.rpc(log, "getRequests", () => client.getRequests(candidateIds), signal);
    const minBounty = this.bountyFloor;
    const maxCallbackGas = this.o.maxCallbackGas ?? 500_000;
    const ids: bigint[] = [];
    const info = new Map<bigint, { bounty: bigint; callbackGasLimit: number; sponsored: boolean }>();
    for (const id of candidateIds) {
      const r = statuses.get(id);
      if (!r || r.status === "fulfilled" || r.status === "none") {
        state.pending.delete(id);
        continue;
      }
      const bounty = r.status === "pending" ? r.bounty : 0n;
      const sponsored = this.sponsored.has(r.requester.toLowerCase());
      if (!sponsored && bounty < minBounty) {
        // Refunded (or below the floor): the bounty can only go down, so stop tracking it.
        state.pending.delete(id);
        log.info("skip_below_floor", { requestId: id, status: r.status, bounty });
        continue;
      }
      if (r.callbackGasLimit > maxCallbackGas) {
        state.pending.delete(id);
        log.info("skip_callback_gas_cap", {
          requestId: id,
          callbackGasLimit: r.callbackGasLimit,
          maxCallbackGas,
        });
        continue;
      }
      ids.push(id);
      info.set(id, { bounty, callbackGasLimit: r.callbackGasLimit, sponsored });
    }
    await this.persist();
    if (ids.length === 0) {
      if (replace) {
        // Everything got settled elsewhere; the stuck tx would now only skip. Leave it to expire in the mempool.
        state.inflight.delete(replace.txHash);
        await this.persist();
      }
      return;
    }
    log = log.child({ requestIds: ids });

    // b. round state and gas price ceiling
    const verified = await this.rpc(log, "roundRandomness", () => client.getRoundRandomness(round), signal);
    const gasPrice = await this.rpc(log, "getGasPrice", () => publicClient.getGasPrice(), signal);
    if (this.o.maxGasPrice !== undefined && gasPrice > this.o.maxGasPrice) {
      return skip("gas_price_too_high", "warn", { gasPrice, maxGasPrice: this.o.maxGasPrice });
    }

    // c. profitability: every paying id covers its own worst-case gas; the batch covers the shared part
    const margin = BigInt(this.o.costMarginPct ?? 120);
    const worstCaseFor = (xs: readonly bigint[]) =>
      worstCaseFulfillBatchGas({
        freshRound: !verified,
        callbackGasLimits: xs.map((id) => info.get(id)?.callbackGasLimit ?? 0),
      });
    const bountyOf = (xs: readonly bigint[]) => xs.reduce((s, id) => s + (info.get(id)?.bounty ?? 0n), 0n);
    const unprofitableMs = this.o.unprofitableRetryMs ?? 60_000;
    if (margin > 0n) {
      const tooCheap = ids.filter((id) => {
        const i = info.get(id);
        if (!i || i.sponsored) return false;
        const own = gasCostUsdc(FULFILL_GAS.perRequest + callbackGasReserve(i.callbackGasLimit), gasPrice);
        return i.bounty * 100n < own * margin;
      });
      if (tooCheap.length > 0) {
        this.defer(tooCheap, unprofitableMs);
        log.info("skip_unprofitable", { requestIds: tooCheap, gasPrice, costMarginPct: Number(margin) });
        for (const id of tooCheap) ids.splice(ids.indexOf(id), 1);
        await this.persist();
        if (ids.length === 0) {
          result.skipped.push({ round, reason: "unprofitable" });
          return;
        }
        log = log.child({ requestIds: ids });
      }
      const anySponsored = ids.some((id) => info.get(id)?.sponsored);
      const cost = gasCostUsdc(worstCaseFor(ids), gasPrice);
      if (!anySponsored && bountyOf(ids) * 100n < cost * margin) {
        this.defer(ids, unprofitableMs);
        await this.persist();
        return skip("unprofitable", "info", {
          bounty: bountyOf(ids),
          worstCaseCostUsdc: cost,
          gasPrice,
          costMarginPct: Number(margin),
        });
      }
    }

    // d. beacon (skipped when the round is already verified onchain)
    let beacon: Beacon | undefined;
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

    // e. simulate (eth_call + eth_estimateGas) with the real fee fields, so tx.gasprice is not 0
    const simulate = (withFees: boolean) =>
      client.simulateFulfillBatch(round, ids, {
        account: this.o.account,
        ...(beacon ? { beacon } : {}),
        ...(withFees ? { fees: { maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n } } : {}),
      });
    let gas: bigint;
    try {
      if (this.o.dryRun) {
        ({ gas } = await this.rpc(log, "simulateFulfillBatch", () => simulate(false), signal));
      } else {
        try {
          ({ gas } = await simulate(true));
        } catch (err) {
          if (err instanceof ContractRevertError) throw err;
          // e.g. a node that rejects fee fields in eth_call: the worst-case gas limit below still applies.
          log.warn("simulation_fee_fields_rejected", { err });
          ({ gas } = await this.rpc(log, "simulateFulfillBatch", () => simulate(false), signal));
        }
      }
    } catch (err) {
      if (err instanceof ContractRevertError) {
        const level = err.errorName === "RoundNotReached" ? "info" : "error";
        return skip("simulation_reverted", level, { errorName: err.errorName, err });
      }
      throw err;
    }

    // f. gas limit: never below the simulation-independent worst case (callbacks may behave differently onchain)
    const worstCase = worstCaseFor(ids);
    const buffered = gas + (gas * BigInt(this.o.gasBufferPct ?? 20)) / 100n;
    const gasLimit = maxOf(buffered, worstCase, replacing?.gasFloor ?? 0n);
    result.simulated.push({ round, requestIds: ids, gas, gasLimit });
    const maxCost = gasCostUsdc(maxOf(gas, worstCase), gasPrice);
    const costUsdc = formatUnits(maxCost, 6);

    if (this.o.dryRun) {
      const key = `${round}:${ids.join(",")}`;
      const first = !this.dryRunLogged.has(key);
      this.dryRunLogged.add(key);
      log[first ? "info" : "debug"]("dry_run_would_fulfill", {
        gas,
        gasLimit,
        worstCaseGas: worstCase,
        gasPrice,
        estCostUsdc: costUsdc,
        bounty: bountyOf(ids),
        from: this.accountAddress,
        batchSize: ids.length,
      });
      return;
    }

    // g. send (or replace a stuck tx with the same nonce and bumped fees), record inflight, then settle
    let replacement: { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
    if (replace?.nonce !== undefined) {
      const bump = BigInt(100 + (this.o.replaceBumpPct ?? 25));
      const prevMax = replace.maxFeePerGas ?? gasPrice;
      const prevTip = replace.maxPriorityFeePerGas ?? 0n;
      const base = gasPrice > prevMax ? gasPrice : prevMax;
      replacement = {
        nonce: replace.nonce,
        maxFeePerGas: (base * bump) / 100n,
        // A zero tip bumps to 1 wei so the node accepts it as a replacement.
        maxPriorityFeePerGas: prevTip === 0n ? 1n : (prevTip * bump) / 100n,
      };
      if (this.o.maxGasPrice !== undefined && replacement.maxFeePerGas > this.o.maxGasPrice) {
        return skip("replacement_gas_price_too_high", "warn", {
          txHash: replace.txHash,
          maxFeePerGas: replacement.maxFeePerGas,
          maxGasPrice: this.o.maxGasPrice,
        });
      }
    }
    let hash: Hash;
    try {
      hash = await client.fulfillBatch(round, ids, {
        gas: gasLimit,
        account: this.o.account,
        ...(beacon ? { beacon } : {}),
        ...(replacement ?? {}),
      });
    } catch (err) {
      if (err instanceof ContractRevertError) {
        return skip("send_reverted", err.errorName === "RequestNotFulfillable" ? "info" : "error", {
          errorName: err.errorName,
          err,
        });
      }
      // e.g. "nonce too low": the stuck tx landed meanwhile. Keep the inflight record; the next tick confirms it.
      if (replace) return skip("replacement_failed", "warn", { txHash: replace.txHash, err });
      throw err;
    }
    this.metrics.txSent++;
    result.sent.push(hash);
    const sentTx = await publicClient.getTransaction({ hash }).catch(() => undefined);
    if (replace) state.inflight.delete(replace.txHash);
    const record: InflightTx = {
      txHash: hash,
      round,
      requestIds: ids,
      sentAt: this.now(),
      nonce: sentTx?.nonce ?? replacement?.nonce,
      maxFeePerGas: sentTx?.maxFeePerGas ?? sentTx?.gasPrice ?? replacement?.maxFeePerGas,
      maxPriorityFeePerGas: sentTx?.maxPriorityFeePerGas ?? replacement?.maxPriorityFeePerGas,
    };
    state.inflight.set(hash, record);
    await this.persist();
    log.info(replace ? "tx_replaced" : "tx_sent", {
      txHash: hash,
      ...(replace ? { replacedTxHash: replace.txHash, nonce: replacement?.nonce } : {}),
      gas,
      gasLimit,
      worstCaseGas: worstCase,
      estCostUsdc: costUsdc,
      batchSize: ids.length,
    });

    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.o.receiptTimeoutMs ?? 60_000,
      });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        // Slow chain, not a failed tick: keep the inflight record; the next ticks confirm, replace or drop it.
        return skip("receipt_timeout", "warn", { txHash: hash });
      }
      throw err;
    }
    state.inflight.delete(hash);
    const events = await this.onReceipt(record, receipt, log.child({ txHash: hash }), result);
    if (!events) return;
    const minedBlock = await publicClient
      .getBlock({ blockNumber: receipt.blockNumber })
      .catch(() => undefined);
    log.info("fulfilled", {
      txHash: hash,
      gasUsed: receipt.gasUsed,
      costUsdc: formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
      batch_size: events.length,
      fulfilled_total: this.metrics.fulfilledTotal,
      // callbackSuccess is also false when no callback ran (EOA requester or callbackGasLimit 0).
      callbacksFailed: events
        .filter((e) => (info.get(e.args.requestId)?.callbackGasLimit ?? 0) > 0 && !e.args.callbackSuccess)
        .map((e) => e.args.requestId),
      bountyPaid: events.reduce((s, e) => s + e.args.bountyPaid, 0n),
      latency_ms: minedBlock ? Number(minedBlock.timestamp - roundTime(round)) * 1000 : undefined,
    });
  }
}
