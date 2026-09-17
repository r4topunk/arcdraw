import { deployments } from "@arcdraw/sdk";
import { type Address, getAddress, type Hex, isAddress, parseGwei, parseUnits } from "viem";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1" || v === "yes");

const intFromEnv = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 20-byte hex address")
  .transform((v) => getAddress(v));

/** Empty strings and `.env.example` placeholders like `[RELAYER_PRIVATE_KEY]` count as unset. */
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && (v.trim() === "" || /^\[[A-Z0-9_]+\]$/.test(v.trim())) ? undefined : v;

/** Raw environment schema. Defaults match `.env.example`. */
export const envSchema = z.object({
  ARC_RPC_URL: z.string().url().default("https://rpc.mainnet.arc.io"),
  ARC_CHAIN_ID: intFromEnv(5042, 1),
  COORDINATOR_ADDRESS: z.preprocess(emptyToUndefined, address.optional()),
  COORDINATOR_DEPLOY_BLOCK: z.preprocess(emptyToUndefined, z.coerce.bigint().nonnegative().optional()),
  RELAYER_START_BLOCK: z.preprocess(emptyToUndefined, z.coerce.bigint().nonnegative().optional()),
  // The key is validated by shape only; its value never appears in errors or logs.
  RELAYER_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, { error: "RELAYER_PRIVATE_KEY must be 0x followed by 64 hex chars" })
      .optional(),
  ),
  RELAYER_ADDRESS: z.preprocess(emptyToUndefined, address.optional()),
  RELAYER_DRY_RUN: z.preprocess(emptyToUndefined, bool),
  DRAND_URLS: z
    .string()
    .default("https://api.drand.sh,https://api2.drand.sh,https://drand.cloudflare.com")
    .transform((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()).min(1)),
  DRAND_TIMEOUT_MS: intFromEnv(5000, 100),
  RELAYER_POLL_MS: intFromEnv(1500, 100),
  /** USDC, decimal string (e.g. "0.01"). Requests with a smaller bounty are left for others. */
  RELAYER_MIN_BOUNTY: z
    .string()
    .default("0")
    .refine((v) => /^\d+(\.\d{1,6})?$/.test(v.trim()), "USDC amount with at most 6 decimals")
    .transform((v) => parseUnits(v.trim(), 6)),
  /** Percent of the worst-case gas cost that the bounties of a batch must cover. 0 = sponsor every request. */
  RELAYER_COST_MARGIN_PCT: intFromEnv(120, 0),
  /** Comma-separated requester addresses relayed regardless of bounty (e.g. your own demo contracts). */
  RELAYER_SPONSORED_REQUESTERS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    )
    .pipe(z.array(address)),
  /** Largest callbackGasLimit this relayer pays for (the coordinator allows up to 500,000). */
  RELAYER_MAX_CALLBACK_GAS: z.coerce.number().int().min(0).max(500_000).default(500_000),
  RELAYER_MAX_GAS_PRICE_GWEI: z
    .string()
    .default("100")
    .refine((v) => /^\d+(\.\d+)?$/.test(v.trim()), "gwei amount")
    .transform((v) => parseGwei(v.trim())),
  RELAYER_MAX_BATCH: intFromEnv(20, 1),
  RELAYER_GAS_BUFFER_PCT: intFromEnv(20, 0),
  RELAYER_RECEIPT_TIMEOUT_MS: intFromEnv(60_000, 1000),
  RELAYER_ERROR_BUDGET: intFromEnv(5, 1),
  RELAYER_SCAN_CHUNK: z.coerce.bigint().min(1n).max(10_000n).default(10_000n),
  RELAYER_STATE_FILE: z.string().min(1).default(".state/cursor.json"),
  RELAYER_HEALTH_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).optional()),
  RELAYER_SHUTDOWN_TIMEOUT_MS: intFromEnv(30_000, 0),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type RelayerConfig = {
  rpcUrl: string;
  chainId: number;
  coordinator: Address;
  startBlock: bigint | undefined;
  privateKey: Hex | undefined;
  /** Sender used for simulation (the key's address, or RELAYER_ADDRESS in dry-run). */
  fromAddress: Address | undefined;
  dryRun: boolean;
  drandUrls: string[];
  drandTimeoutMs: number;
  pollMs: number;
  minBounty: bigint;
  costMarginPct: number;
  sponsoredRequesters: Address[];
  maxCallbackGas: number;
  maxGasPrice: bigint;
  maxBatch: number;
  gasBufferPct: number;
  receiptTimeoutMs: number;
  errorBudget: number;
  scanChunk: bigint;
  stateFile: string;
  healthPort: number | undefined;
  shutdownTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Dead address used as `from` for dry-run simulations when no key or RELAYER_ADDRESS is set. */
export const DRY_RUN_DEFAULT_FROM: Address = "0x000000000000000000000000000000000000dEaD";

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // prettifyError prints paths and messages, never the input values.
    throw new ConfigError(`Invalid relayer environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const known = deployments[e.ARC_CHAIN_ID];
  const coordinator = e.COORDINATOR_ADDRESS ?? known?.coordinator;
  if (!coordinator) {
    throw new ConfigError(
      `COORDINATOR_ADDRESS is required: no known ArcDraw deployment on chain ${e.ARC_CHAIN_ID}`,
    );
  }
  if (!e.RELAYER_DRY_RUN && !e.RELAYER_PRIVATE_KEY) {
    throw new ConfigError("RELAYER_PRIVATE_KEY is required unless RELAYER_DRY_RUN=true");
  }
  const sameAsKnown = known && known.coordinator === coordinator;
  return {
    rpcUrl: e.ARC_RPC_URL,
    chainId: e.ARC_CHAIN_ID,
    coordinator,
    startBlock:
      e.RELAYER_START_BLOCK ?? e.COORDINATOR_DEPLOY_BLOCK ?? (sameAsKnown ? known.deployBlock : undefined),
    privateKey: e.RELAYER_PRIVATE_KEY as Hex | undefined,
    fromAddress: e.RELAYER_ADDRESS,
    dryRun: e.RELAYER_DRY_RUN,
    drandUrls: e.DRAND_URLS,
    drandTimeoutMs: e.DRAND_TIMEOUT_MS,
    pollMs: e.RELAYER_POLL_MS,
    minBounty: e.RELAYER_MIN_BOUNTY,
    costMarginPct: e.RELAYER_COST_MARGIN_PCT,
    sponsoredRequesters: e.RELAYER_SPONSORED_REQUESTERS,
    maxCallbackGas: e.RELAYER_MAX_CALLBACK_GAS,
    maxGasPrice: e.RELAYER_MAX_GAS_PRICE_GWEI,
    maxBatch: e.RELAYER_MAX_BATCH,
    gasBufferPct: e.RELAYER_GAS_BUFFER_PCT,
    receiptTimeoutMs: e.RELAYER_RECEIPT_TIMEOUT_MS,
    errorBudget: e.RELAYER_ERROR_BUDGET,
    scanChunk: e.RELAYER_SCAN_CHUNK,
    stateFile: e.RELAYER_STATE_FILE,
    healthPort: e.RELAYER_HEALTH_PORT,
    shutdownTimeoutMs: e.RELAYER_SHUTDOWN_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
  };
}

/** Config safe to log: the private key is replaced by a presence flag. */
export function describeConfig(c: RelayerConfig): Record<string, unknown> {
  const { privateKey, ...rest } = c;
  return { ...rest, hasPrivateKey: privateKey !== undefined };
}
