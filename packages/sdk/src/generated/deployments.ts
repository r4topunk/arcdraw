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
};
