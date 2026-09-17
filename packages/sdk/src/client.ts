import {
  type Account,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  getAddress,
  type Hash,
  type Hex,
  isAddress,
  type PublicClient,
  parseEventLogs,
  type WalletClient,
  zeroHash,
} from "viem";
import { z } from "zod";
import { COORDINATOR_LIMITS, MAX_LOG_RANGE } from "./constants.js";
import { type Beacon, type FetchBeaconOptions, fetchBeacon } from "./drand.js";
import {
  ArcDrawError,
  ContractRevertError,
  InvalidConfigError,
  MissingWalletError,
  RequestNotFoundError,
  TimeoutError,
  UnsupportedChainError,
} from "./errors.js";
import { arcDrawCoordinatorAbi } from "./generated/abis.js";
import { deployments } from "./generated/deployments.js";

export type RequestStatus = "none" | "pending" | "refunded" | "fulfilled";
const STATUSES: readonly RequestStatus[] = ["none", "pending", "refunded", "fulfilled"];

export type ArcDrawRequest = {
  id: bigint;
  requester: Address;
  round: bigint;
  callbackGasLimit: number;
  status: RequestStatus;
  bounty: bigint;
  createdAt: bigint;
  /** Zero hash until fulfilled. */
  randomness: Hex;
};

export type RequestedEvent = {
  requestId: bigint;
  requester: Address;
  round: bigint;
  bounty: bigint;
  callbackGasLimit: number;
  blockNumber: bigint;
  transactionHash: Hash;
};

export type FulfilledEvent = {
  requestId: bigint;
  round: bigint;
  fulfiller: Address;
  randomness: Hex;
  bountyPaid: bigint;
  callbackSuccess: boolean;
  blockNumber: bigint;
  transactionHash: Hash;
};

/** One `eth_getLogs` window (<= 10,000 blocks) with its decoded coordinator events. */
export type LogChunk = {
  fromBlock: bigint;
  toBlock: bigint;
  requested: RequestedEvent[];
  fulfilled: FulfilledEvent[];
};

const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "invalid address")
  .transform((v) => getAddress(v));

const isObjectWith =
  (...methods: string[]) =>
  (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    methods.every((m) => typeof (v as Record<string, unknown>)[m] === "function");

/** Config for `createArcDraw`. */
export type ArcDrawConfig = {
  publicClient: PublicClient;
  walletClient?: WalletClient | undefined;
  /** Coordinator address. Defaults to the known deployment for the client's chain. */
  coordinator?: string | undefined;
  /** Options used when the SDK fetches a beacon itself. */
  drand?: { urls?: string[] | undefined; timeoutMs?: number | undefined } | undefined;
};

type ResolvedConfig = Omit<ArcDrawConfig, "coordinator"> & { coordinator?: Address | undefined };

/** Runtime validation for `ArcDrawConfig`. */
export const arcDrawConfigSchema: z.ZodType<ResolvedConfig, ArcDrawConfig> = z.object({
  publicClient: z.custom<PublicClient>(
    isObjectWith(
      "readContract",
      "getLogs",
      "getBlockNumber",
      "simulateContract",
      "waitForTransactionReceipt",
    ),
    "publicClient must be a viem PublicClient",
  ),
  walletClient: z
    .custom<WalletClient>(isObjectWith("writeContract"), "walletClient must be a viem WalletClient")
    .optional(),
  /** Coordinator address. Defaults to the known deployment for the client's chain. */
  coordinator: addressSchema.optional(),
  /** Options passed to `fetchBeacon` when the SDK needs a beacon itself. */
  drand: z
    .object({
      urls: z.array(z.string().url()).min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export type RequestOptions = {
  /** Gas for `rawFulfillRandomness` on the requester. 0 (default) = no callback. Max 500,000. */
  callbackGasLimit?: number;
  /** USDC bounty in base units (6 decimals) paid to the fulfiller. Approved automatically. */
  bounty?: bigint;
  /** Pin a specific round (>= minRequestRound). Default: currentRound + 2. */
  round?: bigint;
};

export type TxOverrides = { account?: Account | Address };

/** Map viem errors to `ContractRevertError` carrying the decoded custom error name. */
export function toArcDrawError(err: unknown, functionName?: string): unknown {
  if (err instanceof ArcDrawError) return err;
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return new ContractRevertError(revert.data?.errorName ?? revert.reason, revert.data?.args ?? [], {
        cause: err,
        functionName,
      });
    }
  }
  return err;
}

async function wrap<T>(functionName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toArcDrawError(err, functionName);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Create an ArcDraw client bound to one coordinator.
 *
 * Read methods need only `publicClient`; `request`, `fulfill`, `fulfillBatch` and `refund`
 * need a `walletClient` with an account.
 */
export function createArcDraw(config: ArcDrawConfig): ArcDrawClient {
  const parsed = arcDrawConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new InvalidConfigError(`Invalid ArcDraw config: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  const { publicClient, walletClient, drand } = parsed.data;
  const chainId = publicClient.chain?.id;

  let coordinator: Address;
  if (parsed.data.coordinator) {
    coordinator = parsed.data.coordinator;
  } else {
    const known = chainId === undefined ? undefined : deployments[chainId];
    if (!known) throw new UnsupportedChainError(chainId ?? -1);
    coordinator = known.coordinator;
  }

  const beaconOptions: FetchBeaconOptions = { ...drand };
  const contract = { address: coordinator, abi: arcDrawCoordinatorAbi } as const;
  let usdcAddress: Address | undefined;

  const requireWallet = (action: string) => {
    if (!walletClient?.account) throw new MissingWalletError(action);
    return { wallet: walletClient, account: walletClient.account };
  };

  async function getChainId(): Promise<number> {
    return chainId ?? (await publicClient.getChainId());
  }

  async function usdc(): Promise<Address> {
    usdcAddress ??= await publicClient.readContract({ ...contract, functionName: "USDC" });
    return usdcAddress;
  }

  async function getRequest(id: bigint): Promise<ArcDrawRequest> {
    const r = await wrap("getRequest", () =>
      publicClient.readContract({ ...contract, functionName: "getRequest", args: [id] }),
    );
    const status = STATUSES[r.status] ?? "none";
    if (status === "none") throw new RequestNotFoundError(id);
    return {
      id,
      requester: r.requester,
      round: r.round,
      callbackGasLimit: r.callbackGasLimit,
      status,
      bounty: r.bounty,
      createdAt: r.createdAt,
      randomness: r.randomness,
    };
  }

  /** Statuses for many ids (returns "none" for unknown ids instead of throwing). */
  async function getRequests(ids: readonly bigint[]): Promise<Map<bigint, ArcDrawRequest | undefined>> {
    const out = new Map<bigint, ArcDrawRequest | undefined>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          out.set(id, await getRequest(id));
        } catch (err) {
          if (err instanceof RequestNotFoundError) out.set(id, undefined);
          else throw err;
        }
      }),
    );
    return out;
  }

  async function signatureFor(round: bigint, beacon?: Beacon): Promise<Hex> {
    const stored = await publicClient.readContract({
      ...contract,
      functionName: "roundRandomness",
      args: [round],
    });
    if (stored !== zeroHash) return "0x"; // already verified onchain: signature is ignored
    const b = beacon ?? (await fetchBeacon(round, beaconOptions));
    if (b.round !== round) {
      throw new InvalidConfigError(`beacon is for round ${b.round}, expected ${round}`);
    }
    return b.signature;
  }

  function decodeRequested(logs: Parameters<typeof parseEventLogs>[0]["logs"]): RequestedEvent[] {
    return parseEventLogs({ abi: arcDrawCoordinatorAbi, logs, eventName: "RandomnessRequested" })
      .filter((l) => getAddress(l.address) === coordinator)
      .map((l) => ({
        requestId: l.args.requestId,
        requester: l.args.requester,
        round: l.args.round,
        bounty: l.args.bounty,
        callbackGasLimit: l.args.callbackGasLimit,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
      }));
  }

  const client: ArcDrawClient = {
    coordinator,
    publicClient,
    walletClient,

    getChainId,
    getRequest,
    getRequests,

    /** drand randomness stored for a verified round, or `undefined`. */
    async getRoundRandomness(round: bigint): Promise<Hex | undefined> {
      const v = await publicClient.readContract({
        ...contract,
        functionName: "roundRandomness",
        args: [round],
      });
      return v === zeroHash ? undefined : v;
    },

    /** Fetch and verify the beacon for a round with this client's drand settings. */
    getBeacon(round: bigint | "latest", opts: Omit<FetchBeaconOptions, "urls"> = {}): Promise<Beacon> {
      return fetchBeacon(round, { ...beaconOptions, ...opts });
    },

    /**
     * Request randomness. Approves the coordinator for `bounty` first when the allowance is short.
     * Resolves after the request transaction is mined, with ids parsed from its receipt.
     */
    async request(o: RequestOptions = {}): Promise<{ requestId: bigint; round: bigint; hash: Hash }> {
      const { wallet, account } = requireWallet("request");
      const callbackGasLimit = o.callbackGasLimit ?? 0;
      const bounty = o.bounty ?? 0n;
      if (!Number.isInteger(callbackGasLimit) || callbackGasLimit < 0) {
        throw new InvalidConfigError("callbackGasLimit must be a non-negative integer");
      }
      if (callbackGasLimit > COORDINATOR_LIMITS.maxCallbackGasLimit) {
        throw new InvalidConfigError(
          `callbackGasLimit ${callbackGasLimit} exceeds ${COORDINATOR_LIMITS.maxCallbackGasLimit}`,
        );
      }
      if (bounty < 0n || bounty >= 2n ** 96n) throw new InvalidConfigError("bounty must fit in uint96");

      if (bounty > 0n) {
        const token = await usdc();
        const allowance = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, coordinator],
        });
        if (allowance < bounty) {
          const approveHash = await wrap("approve", () =>
            wallet.writeContract({
              address: token,
              abi: erc20Abi,
              functionName: "approve",
              args: [coordinator, bounty],
              account,
              chain: wallet.chain ?? null,
            }),
          );
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }
      }

      const hash = await wrap(
        o.round === undefined ? "requestRandomness" : "requestRandomnessAtRound",
        async () => {
          if (o.round === undefined) {
            const { request } = await publicClient.simulateContract({
              ...contract,
              functionName: "requestRandomness",
              args: [callbackGasLimit, bounty],
              account,
            });
            return wallet.writeContract({ ...request, chain: wallet.chain ?? null });
          }
          const { request } = await publicClient.simulateContract({
            ...contract,
            functionName: "requestRandomnessAtRound",
            args: [o.round, callbackGasLimit, bounty],
            account,
          });
          return wallet.writeContract({ ...request, chain: wallet.chain ?? null });
        },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new ContractRevertError(undefined, [], { functionName: "request" });
      const ev = decodeRequested(receipt.logs)[0];
      if (!ev) throw new ArcDrawError("EVENT_NOT_FOUND", `no RandomnessRequested event in ${hash}`);
      return { requestId: ev.requestId, round: ev.round, hash };
    },

    /** Poll until the request is fulfilled. Throws `TimeoutError` after `timeoutMs` (default 120 s). */
    async waitForRandomness(
      id: bigint,
      o: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
    ): Promise<{ randomness: Hex; round: bigint }> {
      const deadline = Date.now() + (o.timeoutMs ?? 120_000);
      for (;;) {
        const r = await getRequest(id);
        if (r.status === "fulfilled") return { randomness: r.randomness, round: r.round };
        if (Date.now() >= deadline) {
          throw new TimeoutError(`request ${id} not fulfilled in time`, {
            requestId: String(id),
            round: String(r.round),
          });
        }
        await sleep(o.pollMs ?? 1500, o.signal);
      }
    },

    /** Fulfill one request. Fetches and verifies the beacon unless the round is already verified or `beacon` is given. */
    async fulfill(id: bigint, o: { beacon?: Beacon } & TxOverrides = {}): Promise<Hash> {
      const { wallet, account } = requireWallet("fulfill");
      const r = await getRequest(id);
      const signature = await signatureFor(r.round, o.beacon);
      return wrap("fulfill", async () => {
        const { request } = await publicClient.simulateContract({
          ...contract,
          functionName: "fulfill",
          args: [id, signature],
          account: o.account ?? account,
        });
        return wallet.writeContract({ ...request, chain: wallet.chain ?? null });
      });
    },

    /** Simulate `fulfillBatch` (eth_call + eth_estimateGas only; sends nothing). */
    async simulateFulfillBatch(
      round: bigint,
      ids: readonly bigint[],
      o: { beacon?: Beacon; account: Account | Address },
    ): Promise<{ gas: bigint; signature: Hex }> {
      const signature = await signatureFor(round, o.beacon);
      return wrap("fulfillBatch", async () => {
        await publicClient.simulateContract({
          ...contract,
          functionName: "fulfillBatch",
          args: [round, signature, [...ids]],
          account: o.account,
        });
        const gas = await publicClient.estimateContractGas({
          ...contract,
          functionName: "fulfillBatch",
          args: [round, signature, [...ids]],
          account: o.account,
        });
        return { gas, signature };
      });
    },

    /** Verify `round` once and fulfill every listed request pinned to it. */
    async fulfillBatch(
      round: bigint,
      ids: readonly bigint[],
      o: { beacon?: Beacon; gas?: bigint } & TxOverrides = {},
    ): Promise<Hash> {
      const { wallet, account } = requireWallet("fulfillBatch");
      const signature = await signatureFor(round, o.beacon);
      return wrap("fulfillBatch", async () => {
        const { request } = await publicClient.simulateContract({
          ...contract,
          functionName: "fulfillBatch",
          args: [round, signature, [...ids]],
          account: o.account ?? account,
          ...(o.gas === undefined ? {} : { gas: o.gas }),
        });
        return wallet.writeContract({ ...request, chain: wallet.chain ?? null });
      });
    },

    /** Return an expired Pending request's bounty to its requester (permissionless). */
    async refund(id: bigint): Promise<Hash> {
      const { wallet, account } = requireWallet("refund");
      return wrap("refund", async () => {
        const { request } = await publicClient.simulateContract({
          ...contract,
          functionName: "refund",
          args: [id],
          account,
        });
        return wallet.writeContract({ ...request, chain: wallet.chain ?? null });
      });
    },

    /**
     * Walk coordinator logs in windows of at most `chunkSize` (default and max 10,000) blocks,
     * yielding decoded `RandomnessRequested` and `RandomnessFulfilled` events per window.
     * Persist `chunk.toBlock` as your cursor.
     */
    async *scanLogs(o: {
      fromBlock: bigint;
      toBlock?: bigint;
      chunkSize?: bigint;
    }): AsyncGenerator<LogChunk> {
      const chunk = o.chunkSize ?? MAX_LOG_RANGE;
      if (chunk <= 0n || chunk > MAX_LOG_RANGE) {
        throw new InvalidConfigError(`chunkSize must be in [1, ${MAX_LOG_RANGE}]`);
      }
      const to = o.toBlock ?? (await publicClient.getBlockNumber());
      for (let from = o.fromBlock; from <= to; from += chunk) {
        const end = from + chunk - 1n < to ? from + chunk - 1n : to;
        const logs = await publicClient.getLogs({ address: coordinator, fromBlock: from, toBlock: end });
        const fulfilled = parseEventLogs({
          abi: arcDrawCoordinatorAbi,
          logs,
          eventName: "RandomnessFulfilled",
        }).map((l) => ({
          requestId: l.args.requestId,
          round: l.args.round,
          fulfiller: l.args.fulfiller,
          randomness: l.args.randomness,
          bountyPaid: l.args.bountyPaid,
          callbackSuccess: l.args.callbackSuccess,
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
        }));
        yield { fromBlock: from, toBlock: end, requested: decodeRequested(logs), fulfilled };
      }
    },

    /** Convenience over `scanLogs`: yields every `RandomnessRequested` event in the range. */
    async *scanRequests(o: {
      fromBlock: bigint;
      toBlock?: bigint;
      chunkSize?: bigint;
    }): AsyncGenerator<RequestedEvent> {
      for await (const c of client.scanLogs(o)) yield* c.requested;
    },
  };
  return client;
}

export interface ArcDrawClient {
  readonly coordinator: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  getChainId(): Promise<number>;
  /** Throws `RequestNotFoundError` for unknown ids. */
  getRequest(id: bigint): Promise<ArcDrawRequest>;
  /** Like `getRequest` for many ids; unknown ids map to `undefined`. */
  getRequests(ids: readonly bigint[]): Promise<Map<bigint, ArcDrawRequest | undefined>>;
  getRoundRandomness(round: bigint): Promise<Hex | undefined>;
  getBeacon(round: bigint | "latest", opts?: Omit<FetchBeaconOptions, "urls">): Promise<Beacon>;
  request(o?: RequestOptions): Promise<{ requestId: bigint; round: bigint; hash: Hash }>;
  waitForRandomness(
    id: bigint,
    o?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
  ): Promise<{ randomness: Hex; round: bigint }>;
  fulfill(id: bigint, o?: { beacon?: Beacon } & TxOverrides): Promise<Hash>;
  simulateFulfillBatch(
    round: bigint,
    ids: readonly bigint[],
    o: { beacon?: Beacon; account: Account | Address },
  ): Promise<{ gas: bigint; signature: Hex }>;
  fulfillBatch(
    round: bigint,
    ids: readonly bigint[],
    o?: { beacon?: Beacon; gas?: bigint } & TxOverrides,
  ): Promise<Hash>;
  refund(id: bigint): Promise<Hash>;
  scanLogs(o: { fromBlock: bigint; toBlock?: bigint; chunkSize?: bigint }): AsyncGenerator<LogChunk>;
  scanRequests(o: {
    fromBlock: bigint;
    toBlock?: bigint;
    chunkSize?: bigint;
  }): AsyncGenerator<RequestedEvent>;
}
