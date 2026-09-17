import { createServer, type Server } from "node:http";
import type { RelayerMetrics } from "./relayer.js";

/** `GET /healthz` -> 200 while ticks are recent, 503 once the loop looks stuck. */
export function startHealthServer(opts: {
  port: number;
  metrics: RelayerMetrics;
  staleAfterMs: number;
  dryRun: boolean;
  now?: () => number;
}): Promise<Server> {
  const now = opts.now ?? Date.now;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/healthz" && req.url !== "/")) {
      res.writeHead(404).end();
      return;
    }
    const m = opts.metrics;
    const healthy = m.lastTickAt !== undefined && now() - m.lastTickAt < opts.staleAfterMs;
    const body = JSON.stringify({
      ok: healthy,
      dryRun: opts.dryRun,
      lastTickAt: m.lastTickAt === undefined ? null : new Date(m.lastTickAt).toISOString(),
      lastScannedBlock: m.lastScannedBlock.toString(),
      pending: m.pending,
      ticks: m.ticks,
      fulfilledTotal: m.fulfilledTotal,
      txSent: m.txSent,
      txReverted: m.txReverted,
      quarantined: m.quarantined,
    });
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve(server));
  });
}
