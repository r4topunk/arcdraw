import type { AbiEvent, Address, Log, PublicClient } from "viem";
import { LOG_CHUNK } from "./chain";

/**
 * Find logs for one indexed event near a known unix time, without an indexer.
 * Arc caps eth_getLogs at 10,000 blocks, so we estimate the block from timestamps
 * and scan forward in chunks from slightly before it.
 */
export async function findLogsNear<const event extends AbiEvent>(
  client: PublicClient,
  opts: {
    address: Address;
    event: event;
    args: Record<string, unknown>;
    aroundTs: bigint;
    minBlock?: bigint;
    maxChunks?: number;
  },
): Promise<Log[]> {
  const head = await client.getBlock({ blockTag: "latest" });
  const refNumber = head.number > 200_000n ? head.number - 200_000n : 0n;
  const ref = await client.getBlock({ blockNumber: refNumber });
  const dBlocks = head.number - ref.number;
  const dTs = head.timestamp - ref.timestamp;
  // Blocks per second, scaled by 1000 to keep integer math.
  const bpsMilli = dTs > 0n ? (dBlocks * 1000n) / dTs : 2000n;
  const secondsBack = head.timestamp > opts.aroundTs ? head.timestamp - opts.aroundTs : 0n;
  let estimate = head.number - (secondsBack * bpsMilli) / 1000n;
  if (estimate < 0n) estimate = 0n;

  let from = estimate > 2n * LOG_CHUNK ? estimate - 2n * LOG_CHUNK : 0n;
  if (opts.minBlock !== undefined && from < opts.minBlock) from = opts.minBlock;
  const maxChunks = opts.maxChunks ?? 12;

  for (let i = 0; i < maxChunks && from <= head.number; i++) {
    const to = from + LOG_CHUNK - 1n > head.number ? head.number : from + LOG_CHUNK - 1n;
    const logs = await client.getLogs({
      address: opts.address,
      event: opts.event,
      args: opts.args as never,
      fromBlock: from,
      toBlock: to,
    });
    if (logs.length > 0) return logs as Log[];
    from = to + 1n;
  }
  return [];
}
