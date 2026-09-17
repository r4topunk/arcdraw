import { erc20Abi } from "viem";
import { arcDrawCoordinatorAbi, fairAllocationAbi } from "@arcdraw/sdk";

export { arcDrawCoordinatorAbi };

/** FairAllocation plus the coordinator errors that can bubble up through `draw`. */
export const fairAllocationFullAbi = [
  ...fairAllocationAbi,
  ...arcDrawCoordinatorAbi.filter((x) => x.type === "error"),
] as const;

export const usdcAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const REQUEST_STATUS = ["None", "Pending", "Refunded", "Fulfilled"] as const;
export type RequestStatus = (typeof REQUEST_STATUS)[number];

export const SALE_PHASE = ["None", "Open", "Drawing", "Drawn", "Finalized", "Cancelled"] as const;

/** FairAllocation.DRAW_TIMEOUT: an unfulfilled draw can be cancelled this long after its drand round. */
export const DRAW_TIMEOUT_S = 7 * 24 * 3600;
export type SalePhase = (typeof SALE_PHASE)[number];

export const MAX_CALLBACK_GAS_LIMIT = 500_000;
export const REQUEST_TIMEOUT_S = 3600;
