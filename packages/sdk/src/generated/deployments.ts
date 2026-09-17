// GENERATED FILE, DO NOT EDIT. Regenerate: pnpm --filter @arcdraw/sdk deployments
// Source: deployments/*.json. Chains without a deployed coordinator are omitted.

import type { Address } from "viem";

export type ArcDrawDeployment = {
  chainId: number;
  network: string;
  coordinator: Address;
  fairAllocation: Address | null;
  deployBlock: bigint;
};

export const deployments: Readonly<Record<number, ArcDrawDeployment>> = {
  5042: {
    chainId: 5042,
    network: "arc-mainnet",
    coordinator: "0x3cfDaa3521fDff2b891590c2693972Eb3e1B0324",
    fairAllocation: "0x536aA4934edc6a6d1502F504185B567ef6c53f89",
    deployBlock: 21338070n,
  },
};
