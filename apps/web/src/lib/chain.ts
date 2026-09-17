import { MAX_LOG_RANGE, arcMainnet as sdkArcMainnet } from "@arcdraw/sdk";
import { defineChain } from "viem";

export const ARC_RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.mainnet.arc.io";
export const EXPLORER_URL = "https://explorer.arc.io";

/** SDK chain definition, with the RPC overridable at build time. */
export const arcMainnet = defineChain({
  ...sdkArcMainnet,
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});

export { USDC_ADDRESS } from "@arcdraw/sdk";

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const explorerBlock = (n: bigint | number) => `${EXPLORER_URL}/block/${n.toString()}`;

/** Arc limits eth_getLogs to 10,000-block ranges. */
export const LOG_CHUNK = MAX_LOG_RANGE;
