import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { formatDuration, formatTime } from "./format";

const statusNames = ["None", "Pending", "Refunded", "Fulfilled"];
const phaseNames = ["None", "Open", "Drawing", "Drawn", "Finalized"];

type Args = readonly unknown[] | undefined;
const n = (v: unknown) => (typeof v === "bigint" ? v : BigInt((v as number) ?? 0));

const messages: Record<string, (a: Args) => string> = {
  // ArcDrawCoordinator
  RoundTooSoon: (a) => `Round ${a?.[0]} is too soon. The earliest round you can pin is ${a?.[1]}.`,
  RoundTooFar: (a) => `Round ${a?.[0]} is too far in the future (max ${a?.[1]}).`,
  CallbackGasLimitTooHigh: (a) => `Callback gas limit ${a?.[0]} is above the maximum of ${a?.[1]}.`,
  InvalidSignatureLength: (a) => `The drand signature must be 48 bytes, got ${a?.[0]}.`,
  InvalidSignature: (a) => `The drand signature for round ${a?.[0]} did not verify.`,
  RoundNotReached: (a) =>
    `drand round ${a?.[0]} is not out yet. It is published at ${formatTime(n(a?.[1]))}. Try again in a few seconds.`,
  RequestNotFulfillable: (a) =>
    `Request #${a?.[0]} cannot be fulfilled: it is ${statusNames[Number(a?.[1])] ?? "unknown"}. Someone probably fulfilled it first.`,
  RequestRoundMismatch: (a) => `Request #${a?.[0]} is pinned to round ${a?.[1]}, not ${a?.[2]}.`,
  NotRefundable: (a) => `Request #${a?.[0]} cannot be refunded: it is ${statusNames[Number(a?.[1])] ?? "unknown"}.`,
  NotExpired: (a) => {
    const left = Number(n(a?.[1])) - Math.floor(Date.now() / 1000);
    return `Request #${a?.[0]} has not expired yet. Refunds open at ${formatTime(n(a?.[1]))}${left > 0 ? ` (in ${formatDuration(left)})` : ""}.`;
  },
  InsufficientGasForCallback: () =>
    "Not enough gas was sent to run the consumer callback. Let your wallet estimate gas, or raise the gas limit.",
  Reentrancy: () => "The coordinator blocked a reentrant call.",
  // FairAllocation
  InvalidSaleParams: () =>
    "Invalid sale: treasury must be set, price and slots must be above zero and the deadline must be in the future.",
  WrongPhase: (a) => `Sale #${a?.[0]} is in the ${phaseNames[Number(a?.[1])] ?? "unknown"} phase, so this action is not available.`,
  SubscriptionClosed: (a) => `Subscriptions for sale #${a?.[0]} are closed.`,
  SubscriptionStillOpen: (a) => `Sale #${a?.[0]} is still open until ${formatTime(n(a?.[1]))}.`,
  AlreadySubscribed: (a) => `This address already subscribed to sale #${a?.[0]} (one slot per address).`,
  SaleFull: (a) => `Sale #${a?.[0]} reached the maximum number of participants.`,
  NotOversubscribed: (a) =>
    `Sale #${a?.[0]} is not oversubscribed, so no draw is needed. Call finalize instead: every subscriber gets a slot.`,
  NotEligibleForRefund: () => "This address has no refund to claim (it won a slot, already claimed, or never subscribed).",
  BountyNotReclaimable: (a) => `The draw bounty of sale #${a?.[0]} cannot be reclaimed.`,
  OnlyCoordinator: () => "Only the ArcDraw coordinator can deliver randomness.",
  // USDC / SafeUSDC
  TokenTransferFailed: () => "The USDC transfer failed. Check your balance, allowance and that the address is not blocklisted.",
};

/** Turn any wallet, RPC or contract error into one plain-language sentence. */
export function explainError(err: unknown): string {
  if (!err) return "Something went wrong.";
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && messages[name]) return messages[name](revert.data?.args);
      if (name) return `The contract rejected the call (${name}).`;
      if (revert.reason) return `The contract rejected the call: ${revert.reason}.`;
      return "The contract rejected the call without a reason. Check balances and allowances.";
    }
    const text = `${err.shortMessage} ${err.details ?? ""}`.toLowerCase();
    if (text.includes("insufficient funds") || text.includes("exceeds the balance"))
      return "Your USDC balance is too low to pay for gas (Arc gas is paid in USDC).";
    if (text.includes("chain mismatch") || text.includes("does not match the target chain"))
      return "Your wallet is on another network. Switch to Arc mainnet (chain 5042).";
    if (text.includes("blocklist") || text.includes("blacklist")) return "This address is blocklisted by USDC.";
    if (text.includes("http request failed") || text.includes("fetch failed"))
      return "Could not reach the Arc RPC. Check your connection and try again.";
    if (text.includes("connector not connected") || text.includes("connector not found"))
      return "Connect a wallet first.";
    return err.shortMessage;
  }
  if (err instanceof Error) {
    if (/user rejected|user denied/i.test(err.message)) return "You rejected the request in your wallet.";
    if (/failed to fetch|networkerror/i.test(err.message)) return "Network request failed. Check your connection and try again.";
    return err.message;
  }
  return String(err);
}
