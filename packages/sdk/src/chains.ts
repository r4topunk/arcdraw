import { defineChain } from "viem";
import { arc, arcTestnet as viemArcTestnet } from "viem/chains";

/**
 * Arc mainnet (chainId 5042). Extends viem's `arc` definition, which ships without RPC URLs,
 * with the public RPC, explorer and the canonical Multicall3.
 */
export const arcMainnet = defineChain({
  ...arc,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Arc testnet (chainId 5042002). Adds `https://rpc.testnet.arc.io` in front of viem's RPC list. */
export const arcTestnet = defineChain({
  ...viemArcTestnet,
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.io", ...viemArcTestnet.rpcUrls.default.http],
      webSocket: viemArcTestnet.rpcUrls.default.webSocket,
    },
  },
});

export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_TESTNET_CHAIN_ID = 5042002;
