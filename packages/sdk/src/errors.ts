/**
 * Typed errors. Every error thrown by the SDK is an `ArcDrawError` with a stable `code`,
 * so callers can branch with `err instanceof ArcDrawError && err.code === "DRAND_FETCH_FAILED"`.
 */
export type ArcDrawErrorCode =
  | "INVALID_CONFIG"
  | "UNSUPPORTED_CHAIN"
  | "MISSING_WALLET"
  | "DRAND_FETCH_FAILED"
  | "INVALID_BEACON"
  | "REQUEST_NOT_FOUND"
  | "TIMEOUT"
  | "CONTRACT_REVERT"
  | "EVENT_NOT_FOUND";

export class ArcDrawError extends Error {
  override readonly name: string = "ArcDrawError";
  readonly code: ArcDrawErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ArcDrawErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
  }
}

export class InvalidConfigError extends ArcDrawError {
  override readonly name = "InvalidConfigError";
  constructor(message: string, options: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super("INVALID_CONFIG", message, options);
  }
}

export class UnsupportedChainError extends ArcDrawError {
  override readonly name = "UnsupportedChainError";
  constructor(readonly chainId: number) {
    super(
      "UNSUPPORTED_CHAIN",
      `No ArcDraw deployment known for chain ${chainId}; pass \`coordinator\` explicitly`,
      { details: { chainId } },
    );
  }
}

export class MissingWalletError extends ArcDrawError {
  override readonly name = "MissingWalletError";
  constructor(action: string) {
    super("MISSING_WALLET", `${action} sends a transaction: pass a walletClient with an account`, {
      details: { action },
    });
  }
}

export class DrandFetchError extends ArcDrawError {
  override readonly name = "DrandFetchError";
  constructor(
    readonly round: bigint | "latest",
    readonly attempts: { url: string; error: string }[],
    options: { cause?: unknown } = {},
  ) {
    super("DRAND_FETCH_FAILED", `Could not fetch drand quicknet round ${round} from any endpoint`, {
      ...options,
      details: { round: String(round), attempts },
    });
  }
}

export class InvalidBeaconError extends ArcDrawError {
  override readonly name = "InvalidBeaconError";
  constructor(
    readonly round: bigint,
    reason: string,
  ) {
    super("INVALID_BEACON", `drand beacon for round ${round} is invalid: ${reason}`, {
      details: { round: String(round), reason },
    });
  }
}

export class RequestNotFoundError extends ArcDrawError {
  override readonly name = "RequestNotFoundError";
  constructor(readonly requestId: bigint) {
    super("REQUEST_NOT_FOUND", `ArcDraw request ${requestId} does not exist`, {
      details: { requestId: String(requestId) },
    });
  }
}

export class TimeoutError extends ArcDrawError {
  override readonly name = "TimeoutError";
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("TIMEOUT", message, { details });
  }
}

/** A coordinator call reverted. `errorName` is the decoded custom error (e.g. `RoundTooSoon`) when known. */
export class ContractRevertError extends ArcDrawError {
  override readonly name = "ContractRevertError";
  constructor(
    readonly errorName: string | undefined,
    readonly args: readonly unknown[],
    options: { cause?: unknown; functionName?: string } = {},
  ) {
    super(
      "CONTRACT_REVERT",
      `${options.functionName ?? "call"} reverted${errorName ? ` with ${errorName}` : ""}`,
      { cause: options.cause, details: { errorName, functionName: options.functionName } },
    );
  }
}
