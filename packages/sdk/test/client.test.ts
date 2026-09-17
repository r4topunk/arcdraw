import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  pad,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import { arcMainnet, arcTestnet } from "../src/chains.js";
import { createArcDraw } from "../src/client.js";
import {
  ContractRevertError,
  InvalidConfigError,
  MissingWalletError,
  RequestNotFoundError,
  UnsupportedChainError,
} from "../src/errors.js";
import { arcDrawCoordinatorAbi } from "../src/generated/abis.js";

const COORD: Address = "0x00000000000000000000000000000000A4Cd4A11";
type Rpc = { method: string; params?: unknown };

function mockClient(handler: (req: Rpc) => unknown) {
  const calls: Rpc[] = [];
  const transport = custom({
    async request(req: Rpc) {
      calls.push(req);
      if (req.method === "eth_chainId") return "0x13b2";
      return handler(req);
    },
  });
  return { publicClient: createPublicClient({ chain: arcMainnet, transport }), calls, transport };
}

const requestedLog = (id: bigint, round: bigint, block: bigint) => ({
  address: COORD,
  topics: encodeEventTopics({
    abi: arcDrawCoordinatorAbi,
    eventName: "RandomnessRequested",
    args: { requestId: id, requester: COORD, round },
  }),
  data: encodeAbiParameters([{ type: "uint96" }, { type: "uint32" }], [0n, 0]),
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: pad("0x01", { size: 32 }),
  transactionIndex: "0x0",
  blockHash: pad("0x02", { size: 32 }),
  logIndex: "0x0",
  removed: false,
});

describe("chains", () => {
  it("exports Arc mainnet and testnet with public RPCs", () => {
    expect(arcMainnet.id).toBe(5042);
    expect(arcMainnet.nativeCurrency.symbol).toBe("USDC");
    expect(arcMainnet.rpcUrls.default.http[0]).toBe("https://rpc.mainnet.arc.io");
    expect(arcMainnet.blockExplorers.default.url).toBe("https://explorer.arc.io");
    expect(arcTestnet.id).toBe(5042002);
    expect(arcTestnet.rpcUrls.default.http[0]).toBe("https://rpc.testnet.arc.io");
  });
});

describe("createArcDraw config", () => {
  it("rejects a non-client and a bad coordinator address", () => {
    expect(() => createArcDraw({ publicClient: {} as never, coordinator: COORD })).toThrow(
      InvalidConfigError,
    );
    const { publicClient } = mockClient(() => null);
    expect(() => createArcDraw({ publicClient, coordinator: "0x1234" })).toThrow(InvalidConfigError);
    expect(() => createArcDraw({ publicClient, coordinator: COORD, drand: { urls: ["not a url"] } })).toThrow(
      InvalidConfigError,
    );
  });

  it("requires an explicit coordinator when the chain has no known deployment", () => {
    const { publicClient } = mockClient(() => null);
    expect(() => createArcDraw({ publicClient })).toThrow(UnsupportedChainError);
    const client = createArcDraw({ publicClient, coordinator: COORD.toLowerCase() });
    expect(client.coordinator).toBe(COORD); // checksummed
  });

  it("write methods throw MissingWalletError without a wallet", async () => {
    const { publicClient } = mockClient(() => null);
    const client = createArcDraw({ publicClient, coordinator: COORD });
    await expect(client.refund(1n)).rejects.toBeInstanceOf(MissingWalletError);
    await expect(client.request()).rejects.toBeInstanceOf(MissingWalletError);
  });
});

describe("reads", () => {
  it("maps getRequest and throws RequestNotFoundError for status None", async () => {
    const { publicClient } = mockClient((req) => {
      if (req.method !== "eth_call") throw new Error(`unexpected ${req.method}`);
      const { data } = (req.params as [{ data: Hex }])[0];
      const { args } = decodeFunctionData({ abi: arcDrawCoordinatorAbi, data });
      const id = args?.[0] as bigint;
      return encodeFunctionResult({
        abi: arcDrawCoordinatorAbi,
        functionName: "getRequest",
        result: {
          requester: COORD,
          round: id === 7n ? 1000000n : 0n,
          callbackGasLimit: 60000,
          status: id === 7n ? 3 : 0,
          bounty: 0n,
          createdAt: 123n,
          randomness: id === 7n ? pad("0xaa", { size: 32 }) : zeroHash,
        },
      });
    });
    const client = createArcDraw({ publicClient, coordinator: COORD });
    const r = await client.getRequest(7n);
    expect(r).toMatchObject({ id: 7n, status: "fulfilled", round: 1000000n, callbackGasLimit: 60000 });
    await expect(client.getRequest(8n)).rejects.toBeInstanceOf(RequestNotFoundError);
    const many = await client.getRequests([7n, 8n]);
    expect(many.get(7n)?.status).toBe("fulfilled");
    expect(many.get(8n)).toBeUndefined();
  });

  it("decodes custom errors into ContractRevertError", async () => {
    const revertData = encodeErrorResult({
      abi: arcDrawCoordinatorAbi,
      errorName: "NotExpired",
      args: [1n, 99n],
    });
    const { transport } = mockClient((req) => {
      if (req.method === "eth_call") {
        throw Object.assign(new Error("execution reverted"), { code: 3, data: revertData });
      }
      return null;
    });
    const publicClient = createPublicClient({ chain: arcMainnet, transport });
    const walletClient = createWalletClient({
      chain: arcMainnet,
      transport,
      account: "0x0000000000000000000000000000000000000bee",
    });
    const client = createArcDraw({ publicClient, walletClient, coordinator: COORD });
    const err = await client.refund(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("NotExpired");
    expect((err as ContractRevertError).args).toEqual([1n, 99n]);
  });
});

describe("scanLogs", () => {
  it("never asks eth_getLogs for more than 10,000 blocks and covers the range exactly once", async () => {
    const ranges: [bigint, bigint][] = [];
    const { publicClient } = mockClient((req) => {
      if (req.method !== "eth_getLogs") throw new Error(`unexpected ${req.method}`);
      const f = (req.params as [{ fromBlock: Hex; toBlock: Hex }])[0];
      const from = BigInt(f.fromBlock);
      const to = BigInt(f.toBlock);
      ranges.push([from, to]);
      return from === 10_001n ? [requestedLog(3n, 1000000n, 12_345n)] : [];
    });
    const client = createArcDraw({ publicClient, coordinator: COORD });
    const chunks = [];
    for await (const c of client.scanLogs({ fromBlock: 1n, toBlock: 25_000n })) chunks.push(c);
    expect(ranges).toEqual([
      [1n, 10_000n],
      [10_001n, 20_000n],
      [20_001n, 25_000n],
    ]);
    expect(chunks.map((c) => c.toBlock)).toEqual([10_000n, 20_000n, 25_000n]);
    expect(chunks[1]?.requested[0]).toMatchObject({ requestId: 3n, round: 1000000n, blockNumber: 12_345n });

    const ids = [];
    for await (const r of client.scanRequests({ fromBlock: 1n, toBlock: 25_000n, chunkSize: 5_000n })) {
      ids.push(r.requestId);
    }
    expect(ids).toEqual([3n]);
  });

  it("rejects chunk sizes above the Arc limit", async () => {
    const { publicClient } = mockClient(() => []);
    const client = createArcDraw({ publicClient, coordinator: COORD });
    await expect(
      client.scanLogs({ fromBlock: 0n, toBlock: 1n, chunkSize: 10_001n }).next(),
    ).rejects.toBeInstanceOf(InvalidConfigError);
  });
});
