import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address, Hash } from "viem";
import { z } from "zod";

export type PendingRequest = { round: bigint; bounty: bigint };
export type InflightTx = {
  txHash: Hash;
  requestIds: bigint[];
  sentAt: number;
  /** Sender nonce and fees, read back after sending; used to replace (not duplicate) a stuck tx. */
  nonce?: number | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
};

/** Everything the relayer persists. No database: one JSON file, written atomically. */
export type RelayerState = {
  version: 1;
  chainId: number;
  coordinator: Address;
  /** Last block whose logs were fully processed; -1 before the first scan. */
  lastScannedBlock: bigint;
  pending: Map<bigint, PendingRequest>;
  /** Sent but unconfirmed batches by round; checked before any resubmission (idempotency across restarts). */
  inflight: Map<bigint, InflightTx>;
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
  inflight: z.record(
    z.string(),
    z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      requestIds: z.array(big),
      sentAt: z.number(),
      nonce: z.number().int().nonnegative().optional(),
      maxFeePerGas: big.optional(),
      maxPriorityFeePerGas: big.optional(),
    }),
  ),
});

export function emptyState(chainId: number, coordinator: Address): RelayerState {
  return { version: 1, chainId, coordinator, lastScannedBlock: -1n, pending: new Map(), inflight: new Map() };
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
        [...s.inflight].map(([round, t]) => [
          round.toString(),
          {
            txHash: t.txHash,
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
      Object.entries(f.inflight).map(([r, t]) => [BigInt(r), { ...t, txHash: t.txHash as Hash }]),
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
