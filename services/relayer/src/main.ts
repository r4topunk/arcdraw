#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arcMainnet, arcTestnet, createArcDraw, fetchBeacon } from "@arcdraw/sdk";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ConfigError,
  DRY_RUN_DEFAULT_FROM,
  describeConfig,
  loadConfig,
  type RelayerConfig,
} from "./config.js";
import { startHealthServer } from "./health.js";
import { createLogger, type Logger, serializeError } from "./logger.js";
import { Relayer } from "./relayer.js";
import { sleep } from "./retry.js";
import { FileStateStore } from "./state.js";

function chainFor(c: RelayerConfig): Chain {
  if (c.chainId === arcMainnet.id) return { ...arcMainnet, rpcUrls: { default: { http: [c.rpcUrl] } } };
  if (c.chainId === arcTestnet.id) return { ...arcTestnet, rpcUrls: { default: { http: [c.rpcUrl] } } };
  return defineChain({
    id: c.chainId,
    name: `chain-${c.chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
  });
}

/** Wire config into a running loop. Resolves with the process exit code. */
export async function run(config: RelayerConfig, logger: Logger, signal: AbortSignal): Promise<number> {
  const chain = chainFor(config);
  const transport = http(config.rpcUrl, { retryCount: 2, timeout: 15_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = config.privateKey ? privateKeyToAccount(config.privateKey) : undefined;
  const walletClient =
    account && !config.dryRun ? createWalletClient({ chain, transport, account }) : undefined;
  const from = account?.address ?? config.fromAddress ?? DRY_RUN_DEFAULT_FROM;

  const remoteChainId = await publicClient.getChainId();
  if (remoteChainId !== config.chainId) {
    logger.error("chain_id_mismatch", { expected: config.chainId, rpc: remoteChainId });
    return 1;
  }

  const client = createArcDraw({
    publicClient,
    walletClient,
    coordinator: config.coordinator,
    drand: { urls: config.drandUrls, timeoutMs: config.drandTimeoutMs },
  });
  const relayer = new Relayer({
    client,
    publicClient,
    account: account && !config.dryRun ? account : from,
    store: new FileStateStore(config.stateFile),
    logger,
    fetchBeacon: (round, s) =>
      fetchBeacon(round, {
        urls: config.drandUrls,
        timeoutMs: config.drandTimeoutMs,
        ...(s ? { signal: s } : {}),
      }),
    chainId: config.chainId,
    dryRun: config.dryRun,
    startBlock: config.startBlock,
    minBounty: config.minBounty,
    costMarginPct: config.costMarginPct,
    sponsoredRequesters: config.sponsoredRequesters,
    maxCallbackGas: config.maxCallbackGas,
    maxGasPrice: config.maxGasPrice,
    maxBatch: config.maxBatch,
    gasBufferPct: config.gasBufferPct,
    receiptTimeoutMs: config.receiptTimeoutMs,
    scanChunk: config.scanChunk,
  });
  await relayer.init();

  const health =
    config.healthPort === undefined
      ? undefined
      : await startHealthServer({
          port: config.healthPort,
          metrics: relayer.metrics,
          staleAfterMs: Math.max(30_000, config.pollMs * 10),
          dryRun: config.dryRun,
        });

  logger.info("relayer_started", { ...describeConfig(config), from, healthPort: config.healthPort });

  let failures = 0;
  let exitCode = 0;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await relayer.tick(signal);
      failures = 0;
    } catch (err) {
      if (signal.aborted) break;
      failures++;
      logger.error("tick_failed", { err: serializeError(err), consecutiveFailures: failures });
      if (failures >= config.errorBudget) {
        logger.error("error_budget_exhausted", { consecutiveFailures: failures });
        exitCode = 1;
        break;
      }
    }
    const wait = Math.max(0, config.pollMs - (Date.now() - started));
    await sleep(wait, signal).catch(() => undefined);
  }

  await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()));
  logger.info("relayer_stopped", { exitCode, ...relayer.metrics });
  return exitCode;
}

async function main() {
  let config: RelayerConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    const logger = createLogger({ level: "info" });
    logger.error("config_invalid", { err: err instanceof ConfigError ? err.message : serializeError(err) });
    process.exit(2);
  }
  const runId = crypto.randomUUID();
  const logger = createLogger({ level: config.logLevel, service: "relayer", bindings: { runId } });
  const controller = new AbortController();

  const onSignal = (sig: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      logger.warn("forced_exit", { signal: sig });
      process.exit(130);
    }
    logger.info("shutdown_requested", { signal: sig, timeoutMs: config.shutdownTimeoutMs });
    controller.abort(new Error(`received ${sig}`));
    setTimeout(() => {
      logger.error("shutdown_timeout", { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    process.exitCode = await run(config, logger, controller.signal);
  } catch (err) {
    logger.error("fatal", { err: serializeError(err) });
    process.exitCode = 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (invokedDirectly()) void main();
