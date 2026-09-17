import { defineChain } from "viem";
import { arc } from "viem/chains";

export const ARC_RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.mainnet.arc.io";
export const EXPLORER_URL = "https://explorer.arc.io";

/** viem ships `arc` without RPC or explorer; fill them in for the browser. */
export const arcMainnet = defineChain({
  ...arc,
  id: 5042,
  name: "Arc",
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER_URL } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const explorerBlock = (n: bigint | number) => `${EXPLORER_URL}/block/${n.toString()}`;

/** Arc limits eth_getLogs to 10,000-block ranges. */
export const LOG_CHUNK = 10_000n;
