import { getAddress, isAddress, type Address } from "viem";
import raw from "../../../../deployments/arc-mainnet.json";

type Entry = { address: string; deployBlock: number | null; deployTx: string; verified: boolean };

function pick(envValue: string | undefined, entry: Entry | undefined): Address | null {
  const candidate = envValue || entry?.address || "";
  return isAddress(candidate) ? getAddress(candidate) : null;
}

const contracts = raw.contracts as Record<string, Entry>;

export const deployments = {
  chainId: raw.chainId,
  coordinator: pick(process.env.NEXT_PUBLIC_COORDINATOR_ADDRESS, contracts.ArcDrawCoordinator),
  fairAllocation: pick(process.env.NEXT_PUBLIC_FAIR_ALLOCATION_ADDRESS, contracts.FairAllocation),
  coordinatorDeployBlock: contracts.ArcDrawCoordinator?.deployBlock ?? null,
  coordinatorDeployTx: contracts.ArcDrawCoordinator?.deployTx || null,
  fairAllocationDeployTx: contracts.FairAllocation?.deployTx || null,
  proofs: raw.proofs as Record<string, unknown>,
} as const;

export const isDeployed = deployments.coordinator !== null;
