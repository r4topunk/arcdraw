import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address, Hash } from "viem";
import { z } from "zod";

export type PendingRequest = { round: bigint; bounty: bigint };

/** One sent `fulfillBatch` transaction. Tracked per transaction (not per round), so batches never share a record. */
export type InflightTx = {
  txHash: Hash;
  round: bigint;
  requestIds: bigint[];
  sentAt: number;
  /** Sender nonce and fees, read back after sending; used to replace (not duplicate) a stuck tx. */
  nonce?: number | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
};

/**
 * Backoff for a request id. `maxGroup` is set after an onchain batch revert (bisection: the id is only sent in
 * batches of at most that size); `strikes` counts reverts of batches that contained only this id.
 */
export type QuarantineEntry = { strikes: number; notBefore: number; maxGroup?: number | undefined };

/** Everything the relayer persists. No database: one JSON file, written atomically. */
export type RelayerState = {
  version: 1;
  chainId: number;
  coordinator: Address;
  /** Last block whose logs were fully processed; -1 before the first scan. */
  lastScannedBlock: bigint;
  pending: Map<bigint, PendingRequest>;
  /** Sent but unconfirmed batches by tx hash; checked before any resubmission (idempotency across restarts). */
  inflight: Map<Hash, InflightTx>;
  /** Request ids that are backed off (onchain reverts, bisection, unprofitable at the current gas price). */
  quarantine: Map<bigint, QuarantineEntry>;
};

const big = z
  .string()
  .regex(/^-?\d+$/)
  .transform(BigInt);

const fileSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int(),
  coordinator: z.string(),
  lastScannedBlock: big,
  pending: z.record(z.string(), z.object({ round: big, bounty: big })),
  /** Keyed by tx hash. Files written before per-tx tracking are keyed by round and have no `round` field. */
  inflight: z.record(
    z.string(),
    z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      round: big.optional(),
      requestIds: z.array(big),
      sentAt: z.number(),
      nonce: z.number().int().nonnegative().optional(),
      maxFeePerGas: big.optional(),
      maxPriorityFeePerGas: big.optional(),
    }),
  ),
  quarantine: z
    .record(
      z.string(),
      z.object({
        strikes: z.number().int().nonnegative(),
        notBefore: z.number(),
        maxGroup: z.number().int().positive().optional(),
      }),
    )
    .default({}),
});

export function emptyState(chainId: number, coordinator: Address): RelayerState {
  return {
    version: 1,
    chainId,
    coordinator,
    lastScannedBlock: -1n,
    pending: new Map(),
    inflight: new Map(),
    quarantine: new Map(),
  };
}

export function serializeState(s: RelayerState): string {
  return `${JSON.stringify(
    {
      version: s.version,
      chainId: s.chainId,
      coordinator: s.coordinator,
      lastScannedBlock: s.lastScannedBlock.toString(),
      pending: Object.fromEntries(
        [...s.pending].map(([id, p]) => [
          id.toString(),
          { round: p.round.toString(), bounty: p.bounty.toString() },
        ]),
      ),
      inflight: Object.fromEntries(
        [...s.inflight.values()].map((t) => [
          t.txHash,
          {
            txHash: t.txHash,
            round: t.round.toString(),
            requestIds: t.requestIds.map(String),
            sentAt: t.sentAt,
            ...(t.nonce === undefined ? {} : { nonce: t.nonce }),
            ...(t.maxFeePerGas === undefined ? {} : { maxFeePerGas: t.maxFeePerGas.toString() }),
            ...(t.maxPriorityFeePerGas === undefined
              ? {}
              : { maxPriorityFeePerGas: t.maxPriorityFeePerGas.toString() }),
          },
        ]),
      ),
      quarantine: Object.fromEntries(
        [...s.quarantine].map(([id, q]) => [
          id.toString(),
          {
            strikes: q.strikes,
            notBefore: q.notBefore,
            ...(q.maxGroup === undefined ? {} : { maxGroup: q.maxGroup }),
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}

export function parseState(json: string): RelayerState {
  const f = fileSchema.parse(JSON.parse(json));
  return {
    version: 1,
    chainId: f.chainId,
    coordinator: f.coordinator as Address,
    lastScannedBlock: f.lastScannedBlock,
    pending: new Map(Object.entries(f.pending).map(([id, p]) => [BigInt(id), p])),
    inflight: new Map(
      Object.entries(f.inflight).map(([key, t]) => {
        const txHash = t.txHash as Hash;
        const { round, ...rest } = t;
        return [txHash, { ...rest, txHash, round: round ?? BigInt(key) }];
      }),
    ),
    quarantine: new Map(
      Object.entries(f.quarantine).map(([id, q]) => [
        BigInt(id),
        {
          strikes: q.strikes,
          notBefore: q.notBefore,
          ...(q.maxGroup === undefined ? {} : { maxGroup: q.maxGroup }),
        },
      ]),
    ),
  };
}

export interface StateStore {
  load(): Promise<RelayerState | undefined>;
  save(state: RelayerState): Promise<void>;
}

/** Atomic JSON file store (write to temp file, then rename). */
export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<RelayerState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return parseState(raw);
  }

  async save(state: RelayerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, serializeState(state), "utf8");
    await rename(tmp, this.path);
  }
}

export class MemoryStateStore implements StateStore {
  private data: string | undefined;
  async load() {
    return this.data === undefined ? undefined : parseState(this.data);
  }
  async save(state: RelayerState) {
    this.data = serializeState(state);
  }
}
