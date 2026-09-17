// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BLS2} from "bls-solidity/libraries/BLS2.sol";
import {IArcDrawCoordinator} from "./interfaces/IArcDrawCoordinator.sol";
import {IArcDrawConsumer} from "./interfaces/IArcDrawConsumer.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {SafeUSDC} from "./utils/SafeUSDC.sol";

/// @title ArcDrawCoordinator
/// @author ArcDraw
/// @notice Permissionless randomness for Arc. A request pins a future drand quicknet round
///         (League of Entropy, BLS12-381 G1, RFC 9380). Anyone may fulfill it by submitting that
///         round's BLS signature, which is verified onchain through the EIP-2537 precompiles with
///         randa-mu/bls-solidity (MIT, vendored in lib/bls-solidity). No owner, no pause, no upgrade.
/// @dev EXPERIMENTAL: the vendored BLS library is unaudited. See docs/SPEC.md section 3.
contract ArcDrawCoordinator is IArcDrawCoordinator {
    using SafeUSDC for IERC20Minimal;

    // ------------------------------------------------------------------ constants

    /// @inheritdoc IArcDrawCoordinator
    uint64 public constant GENESIS_TIME = 1692803367;
    /// @inheritdoc IArcDrawCoordinator
    uint64 public constant PERIOD = 3;
    /// @inheritdoc IArcDrawCoordinator
    uint64 public constant MIN_ROUND_DELAY = 2;
    /// @inheritdoc IArcDrawCoordinator
    uint64 public constant MAX_ROUND_DELAY = 10_512_000;
    /// @inheritdoc IArcDrawCoordinator
    uint32 public constant MAX_CALLBACK_GAS_LIMIT = 500_000;
    /// @inheritdoc IArcDrawCoordinator
    uint64 public constant REQUEST_TIMEOUT = 3600;

    /// @notice drand quicknet chain hash (informational; the public key below is what is enforced).
    bytes32 public constant DRAND_CHAIN_HASH = 0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;

    bytes internal constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    /// @dev Gas kept back on top of callbackGasLimit (EIP-150 1/63 plus call overhead).
    uint256 internal constant CALLBACK_GAS_OVERHEAD = 5_000;

    // BLS12-381 base field modulus p, split as (hi 128 bits, lo 256 bits).
    uint256 internal constant P_HI = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
    uint256 internal constant P_LO = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    // ------------------------------------------------------------------ storage

    /// @inheritdoc IArcDrawCoordinator
    address public immutable USDC;

    /// @inheritdoc IArcDrawCoordinator
    uint256 public requestCount;

    /// @inheritdoc IArcDrawCoordinator
    mapping(uint64 round => bytes32 drandRandomness) public roundRandomness;

    mapping(uint256 requestId => Request) internal _requests;

    error Reentrancy();

    modifier nonReentrant() {
        assembly ("memory-safe") {
            if tload(0) {
                mstore(0, 0xab143c06) // Reentrancy()
                revert(0x1c, 0x04)
            }
            tstore(0, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(0, 0)
        }
    }

    /// @param usdc The USDC ERC-20 (6 decimals). On Arc: 0x3600000000000000000000000000000000000000.
    constructor(address usdc) {
        USDC = usdc;
    }

    // ------------------------------------------------------------------ requests

    /// @inheritdoc IArcDrawCoordinator
    function requestRandomness(uint32 callbackGasLimit, uint96 bounty)
        external
        returns (uint256 requestId, uint64 round)
    {
        round = minRequestRound();
        requestId = _request(round, callbackGasLimit, bounty);
    }

    /// @inheritdoc IArcDrawCoordinator
    function requestRandomnessAtRound(uint64 round, uint32 callbackGasLimit, uint96 bounty)
        external
        returns (uint256 requestId)
    {
        uint64 minRound = minRequestRound();
        if (round < minRound) revert RoundTooSoon(round, minRound);
        uint64 maxRound = minRound - MIN_ROUND_DELAY + MAX_ROUND_DELAY;
        if (round > maxRound) revert RoundTooFar(round, maxRound);
        requestId = _request(round, callbackGasLimit, bounty);
    }

    function _request(uint64 round, uint32 callbackGasLimit, uint96 bounty) internal returns (uint256 requestId) {
        if (callbackGasLimit > MAX_CALLBACK_GAS_LIMIT) {
            revert CallbackGasLimitTooHigh(callbackGasLimit, MAX_CALLBACK_GAS_LIMIT);
        }
        unchecked {
            requestId = ++requestCount;
        }
        _requests[requestId] = Request({
            requester: msg.sender,
            round: round,
            callbackGasLimit: callbackGasLimit,
            status: Status.Pending,
            bounty: bounty,
            createdAt: uint64(block.timestamp),
            randomness: bytes32(0)
        });
        if (bounty > 0) IERC20Minimal(USDC).safeTransferFrom(msg.sender, address(this), bounty);
        emit RandomnessRequested(requestId, msg.sender, round, bounty, callbackGasLimit);
    }

    // ------------------------------------------------------------------ fulfillment

    /// @inheritdoc IArcDrawCoordinator
    function verifyRound(uint64 round, bytes calldata signature) external returns (bytes32 drandRandomness) {
        return _verify(round, signature);
    }

    /// @inheritdoc IArcDrawCoordinator
    function fulfill(uint256 requestId, bytes calldata signature) external nonReentrant {
        Request storage r = _requests[requestId];
        Status status = r.status;
        if (status != Status.Pending && status != Status.Refunded) revert RequestNotFulfillable(requestId, status);

        bytes32 d = _verify(r.round, signature);
        (bytes32 rand, uint96 bountyPaid) = _settle(r, requestId, d);

        if (bountyPaid > 0) IERC20Minimal(USDC).safeTransfer(msg.sender, bountyPaid);
        bool ok = _callback(r, requestId, rand);
        emit RandomnessFulfilled(requestId, r.round, msg.sender, rand, bountyPaid, ok);
    }

    /// @inheritdoc IArcDrawCoordinator
    function fulfillBatch(uint64 round, bytes calldata signature, uint256[] calldata requestIds) external nonReentrant {
        bytes32 d = _verify(round, signature);
        uint256 n = requestIds.length;
        uint96[] memory paid = new uint96[](n);
        bool[] memory done = new bool[](n);
        uint256 total;

        for (uint256 i; i < n; ++i) {
            uint256 id = requestIds[i];
            Request storage r = _requests[id];
            Status status = r.status;
            if (status != Status.Pending && status != Status.Refunded) continue; // lost a race or duplicate id
            if (r.round != round) revert RequestRoundMismatch(id, r.round, round);
            (, uint96 bountyPaid) = _settle(r, id, d);
            paid[i] = bountyPaid;
            done[i] = true;
            total += bountyPaid;
        }

        if (total > 0) IERC20Minimal(USDC).safeTransfer(msg.sender, total);

        for (uint256 i; i < n; ++i) {
            if (!done[i]) continue;
            uint256 id = requestIds[i];
            Request storage r = _requests[id];
            bytes32 rand = r.randomness;
            bool ok = _callback(r, id, rand);
            emit RandomnessFulfilled(id, round, msg.sender, rand, paid[i], ok);
        }
    }

    /// @inheritdoc IArcDrawCoordinator
    function refund(uint256 requestId) external nonReentrant {
        Request storage r = _requests[requestId];
        if (r.status != Status.Pending) revert NotRefundable(requestId, r.status);
        uint64 expiry = _roundTimestamp(r.round) + REQUEST_TIMEOUT;
        if (block.timestamp < expiry) revert NotExpired(requestId, expiry);

        uint96 bounty = r.bounty;
        address requester = r.requester;
        r.status = Status.Refunded;
        r.bounty = 0;
        if (bounty > 0) IERC20Minimal(USDC).safeTransfer(requester, bounty);
        emit BountyRefunded(requestId, requester, bounty);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IArcDrawCoordinator
    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    /// @inheritdoc IArcDrawCoordinator
    function currentRound() public view returns (uint64) {
        return _currentRound(block.timestamp);
    }

    /// @inheritdoc IArcDrawCoordinator
    function minRequestRound() public view returns (uint64) {
        return _currentRound(block.timestamp) + MIN_ROUND_DELAY;
    }

    /// @inheritdoc IArcDrawCoordinator
    function maxRequestRound() external view returns (uint64) {
        return _currentRound(block.timestamp) + MAX_ROUND_DELAY;
    }

    /// @inheritdoc IArcDrawCoordinator
    function roundTimestamp(uint64 round) external pure returns (uint64) {
        return _roundTimestamp(round);
    }

    /// @inheritdoc IArcDrawCoordinator
    function expiresAt(uint256 requestId) external view returns (uint64) {
        Request storage r = _requests[requestId];
        if (r.status == Status.None) return 0;
        return _roundTimestamp(r.round) + REQUEST_TIMEOUT;
    }

    // ------------------------------------------------------------------ internals

    function _currentRound(uint256 t) internal pure returns (uint64) {
        if (t < GENESIS_TIME) return 0;
        return uint64((t - GENESIS_TIME) / PERIOD + 1);
    }

    /// @dev Round 0 does not exist; it maps to GENESIS_TIME. Rounds stored in requests are bounded by
    ///      MAX_ROUND_DELAY, so the uint64 arithmetic cannot overflow for them.
    function _roundTimestamp(uint64 round) internal pure returns (uint64) {
        if (round == 0) return GENESIS_TIME;
        return uint64(uint256(GENESIS_TIME) + (uint256(round) - 1) * PERIOD);
    }

    /// @dev Marks a request fulfilled and returns its randomness and the bounty owed to the fulfiller.
    function _settle(Request storage r, uint256 requestId, bytes32 d)
        internal
        returns (bytes32 rand, uint96 bountyPaid)
    {
        rand = keccak256(abi.encode(d, block.chainid, address(this), requestId));
        bountyPaid = r.status == Status.Pending ? r.bounty : 0;
        r.status = Status.Fulfilled;
        r.bounty = 0;
        r.randomness = rand;
    }

    /// @dev Gas-limited callback. The fulfiller must provide enough gas; the callee's failure is recorded,
    ///      never bubbled. Return data is not copied (returndata-bomb safe).
    function _callback(Request storage r, uint256 requestId, bytes32 rand) internal returns (bool success) {
        uint256 gasLimit = r.callbackGasLimit;
        address target = r.requester;
        if (gasLimit == 0 || target.code.length == 0) return false;
        bytes memory data = abi.encodeCall(IArcDrawConsumer.rawFulfillRandomness, (requestId, rand));
        uint256 required = gasLimit + gasLimit / 63 + CALLBACK_GAS_OVERHEAD;
        if (gasleft() < required) revert InsufficientGasForCallback(gasleft(), required);
        assembly ("memory-safe") {
            success := call(gasLimit, target, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    /// @dev Verify-once cache. Reverts unless `signature` is drand quicknet's signature for `round`.
    function _verify(uint64 round, bytes calldata signature) internal returns (bytes32 d) {
        d = roundRandomness[round];
        if (d != bytes32(0)) return d;
        if (signature.length != 48) revert InvalidSignatureLength(signature.length);
        uint64 ts = _roundTimestamp(round);
        if (round == 0 || block.timestamp < ts) revert RoundNotReached(round, ts);
        if (!_isCanonicalCompressedG1(signature) || !_verifyBls(round, signature)) revert InvalidSignature(round);
        d = sha256(signature);
        roundRandomness[round] = d;
        emit RoundVerified(round, d, signature);
    }

    /// @dev Enforces a unique byte encoding per point, so `sha256(signature)` cannot be ground by re-encoding:
    ///      compression flag set, infinity flag clear, x < p. The sign flag is checked by the pairing.
    function _isCanonicalCompressedG1(bytes calldata sig) internal pure returns (bool) {
        uint256 hi;
        uint256 lo;
        assembly ("memory-safe") {
            hi := shr(128, calldataload(sig.offset))
            lo := calldataload(add(sig.offset, 16))
        }
        uint256 flags = hi >> 125;
        if (flags & 0x4 == 0 || flags & 0x2 != 0) return false;
        hi &= (uint256(1) << 125) - 1;
        return hi < P_HI || (hi == P_HI && lo < P_LO);
    }

    /// @dev BLS verification of the quicknet signature for `round` with randa-mu BLS2.
    ///      Message = sha256(uint64_be(round)), hashed to G1 with DST (RFC 9380).
    ///      Virtual only so tests can substitute arbitrary rounds; production uses this body.
    function _verifyBls(uint64 round, bytes calldata signature) internal view virtual returns (bool) {
        (bool pairingOk, bool callOk) = BLS2.verifySingle(
            BLS2.g1UnmarshalCompressed(signature),
            _publicKey(),
            BLS2.hashToPoint(DST, abi.encodePacked(sha256(abi.encodePacked(round))))
        );
        return pairingOk && callOk;
    }

    /// @dev drand quicknet group public key (G2), from https://api.drand.sh/<chainhash>/info.
    function _publicKey() internal pure returns (BLS2.PointG2 memory) {
        return BLS2.PointG2(
            0x03cf0f2896adee7eb8b5f01fcad39122,
            0x12c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451,
            0x0d1fec758c921cc22b0e17e63aaf4bcb,
            0x5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a,
            0x01a714f2edb74119a2f2b0d5a7c75ba9,
            0x02d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b,
            0x0e5db2b6bfbb01c867749cadffca88b3,
            0x6c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273
        );
    }
}
