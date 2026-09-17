// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IArcDrawCoordinator
/// @notice Permissionless randomness coordinator for Arc, backed by drand quicknet beacons
///         verified onchain (BLS12-381 G1, RFC 9380) via EIP-2537 precompiles.
/// @dev Stage 1 contract surface. See docs/SPEC.md for the binding semantics.
///      The drand round is fixed at request time, so the outcome of a request is fixed
///      as soon as it is created. A refund only returns the bounty; the request can still be
///      fulfilled afterwards and its callback still runs.
interface IArcDrawCoordinator {
    enum Status {
        None, // unknown requestId
        Pending, // waiting for its drand round, bounty escrowed
        Refunded, // expired without fulfillment, bounty returned; still fulfillable (no bounty)
        Fulfilled // randomness delivered (terminal)
    }

    /// @dev Packed in two slots, plus `randomness`.
    struct Request {
        address requester; // msg.sender of the request; callback target; refund recipient
        uint64 round; // drand quicknet round pinned at request time
        uint32 callbackGasLimit; // 0 = no callback (EOA or pull-based consumers)
        Status status;
        uint96 bounty; // USDC, 6 decimals, paid to the fulfiller
        uint64 createdAt; // block.timestamp at request
        bytes32 randomness; // 0 until fulfilled
    }

    // ---------------------------------------------------------------- events

    event RandomnessRequested(
        uint256 indexed requestId,
        address indexed requester,
        uint64 indexed round,
        uint96 bounty,
        uint32 callbackGasLimit
    );

    /// @param drandRandomness sha256(signature), identical to drand's published `randomness`.
    event RoundVerified(uint64 indexed round, bytes32 drandRandomness, bytes signature);

    event RandomnessFulfilled(
        uint256 indexed requestId,
        uint64 indexed round,
        address indexed fulfiller,
        bytes32 randomness,
        uint96 bountyPaid,
        bool callbackSuccess
    );

    event BountyRefunded(uint256 indexed requestId, address indexed requester, uint96 bounty);

    // ---------------------------------------------------------------- errors

    error RoundTooSoon(uint64 round, uint64 minRound);
    error RoundTooFar(uint64 round, uint64 maxRound);
    error CallbackGasLimitTooHigh(uint32 callbackGasLimit, uint32 maxCallbackGasLimit);
    error InvalidSignatureLength(uint256 length);
    error InvalidSignature(uint64 round);
    error RoundNotReached(uint64 round, uint64 roundTimestamp);
    error RequestNotFulfillable(uint256 requestId, Status status);
    error RequestRoundMismatch(uint256 requestId, uint64 expectedRound, uint64 givenRound);
    error NotRefundable(uint256 requestId, Status status);
    error NotExpired(uint256 requestId, uint64 expiresAt);
    error InsufficientGasForCallback(uint256 gasLeft, uint256 gasRequired);

    // ---------------------------------------------------------------- requests

    /// @notice Request randomness for round `currentRound() + MIN_ROUND_DELAY`.
    /// @param callbackGasLimit Gas forwarded to `IArcDrawConsumer.rawFulfillRandomness`; 0 disables callback.
    /// @param bounty USDC (6 decimals) pulled from msg.sender via transferFrom; 0 allowed.
    function requestRandomness(uint32 callbackGasLimit, uint96 bounty)
        external
        returns (uint256 requestId, uint64 round);

    /// @notice Request randomness for a specific future round, in [minRequestRound(), maxRequestRound()].
    function requestRandomnessAtRound(uint64 round, uint32 callbackGasLimit, uint96 bounty)
        external
        returns (uint256 requestId);

    // ---------------------------------------------------------------- fulfillment

    /// @notice Verify and store a drand quicknet round. Idempotent: returns stored value if already verified.
    /// @param signature 48-byte compressed G1 signature exactly as served by the drand HTTP API.
    function verifyRound(uint64 round, bytes calldata signature) external returns (bytes32 drandRandomness);

    /// @notice Fulfill one request. `signature` is ignored (may be empty) if the round is already verified.
    function fulfill(uint256 requestId, bytes calldata signature) external;

    /// @notice Verify `round` once and fulfill every listed request pinned to it.
    /// @dev Requests that are no longer fulfillable (already Fulfilled by a racing relayer) are skipped, not reverted.
    ///      A listed request pinned to a different round reverts with RequestRoundMismatch.
    function fulfillBatch(uint64 round, bytes calldata signature, uint256[] calldata requestIds) external;

    /// @notice Return the bounty of a Pending request to its requester after `expiresAt(requestId)`.
    /// @dev Permissionless. Does not cancel the request: it stays fulfillable with no bounty.
    function refund(uint256 requestId) external;

    // ---------------------------------------------------------------- views

    function USDC() external view returns (address);
    function GENESIS_TIME() external view returns (uint64); // 1692803367
    function PERIOD() external view returns (uint64); // 3
    function MIN_ROUND_DELAY() external view returns (uint64); // 4 (pinned round published > 9 s after block.timestamp)
    function MAX_ROUND_DELAY() external view returns (uint64); // 10_512_000 (~1 year of 3s rounds)
    function MAX_CALLBACK_GAS_LIMIT() external view returns (uint32); // 500_000
    function REQUEST_TIMEOUT() external view returns (uint64); // 3600 seconds after the round timestamp

    function requestCount() external view returns (uint256);
    function getRequest(uint256 requestId) external view returns (Request memory);
    function roundRandomness(uint64 round) external view returns (bytes32); // 0 if not verified
    /// @notice Bounty returned to the requester by `refund` (0 if never refunded). Survives a later
    ///         fulfillment, so consumers can account for refunded bounties without racing late fulfillers.
    function refundedBounty(uint256 requestId) external view returns (uint96);

    /// @notice Latest round whose beacon is due at block.timestamp: floor((t - GENESIS_TIME) / PERIOD) + 1.
    function currentRound() external view returns (uint64);
    /// @notice currentRound() + MIN_ROUND_DELAY.
    function minRequestRound() external view returns (uint64);
    /// @notice currentRound() + MAX_ROUND_DELAY.
    function maxRequestRound() external view returns (uint64);
    /// @notice GENESIS_TIME + (round - 1) * PERIOD (GENESIS_TIME for round 0), saturating at type(uint64).max.
    function roundTimestamp(uint64 round) external view returns (uint64);
    /// @notice roundTimestamp(request.round) + REQUEST_TIMEOUT.
    function expiresAt(uint256 requestId) external view returns (uint64);
}
