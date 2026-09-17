// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./utils/BaseTest.sol";
import {IArcDrawCoordinator} from "../src/interfaces/IArcDrawCoordinator.sol";
import {ArcDrawConsumer} from "../src/ArcDrawConsumer.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {SafeUSDC} from "../src/utils/SafeUSDC.sol";
import {
    RecordingConsumer,
    RevertingConsumer,
    GasGuzzlerConsumer,
    ReturnDataBombConsumer,
    ReentrantConsumer,
    GasProbeConsumer
} from "./mocks/Consumers.sol";

contract ArcDrawCoordinatorTest is BaseTest {
    event RandomnessRequested(
        uint256 indexed requestId,
        address indexed requester,
        uint64 indexed round,
        uint96 bounty,
        uint32 callbackGasLimit
    );
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

    // ================================================================ constants & round math

    function test_constants() public view {
        assertEq(coord.USDC(), ARC_USDC);
        assertEq(coord.GENESIS_TIME(), 1692803367);
        assertEq(coord.PERIOD(), 3);
        assertEq(coord.MIN_ROUND_DELAY(), 2);
        assertEq(coord.MAX_ROUND_DELAY(), 10_512_000);
        assertEq(coord.MAX_CALLBACK_GAS_LIMIT(), 500_000);
        assertEq(coord.REQUEST_TIMEOUT(), 3600);
        assertEq(coord.requestCount(), 0);
    }

    function test_roundMath_knownVectors() public {
        vm.warp(GENESIS - 1);
        assertEq(coord.currentRound(), 0);
        vm.warp(GENESIS);
        assertEq(coord.currentRound(), 1);
        vm.warp(GENESIS + 2);
        assertEq(coord.currentRound(), 1);
        vm.warp(GENESIS + 3);
        assertEq(coord.currentRound(), 2);
        assertEq(coord.roundTimestamp(0), GENESIS);
        assertEq(coord.roundTimestamp(1), GENESIS);
        assertEq(coord.roundTimestamp(1000000), 1695803364); // drand quicknet round 1000000
    }

    function testFuzz_roundMath_matchesReference(uint64 t) public {
        t = uint64(bound(t, GENESIS, type(uint32).max * uint64(8)));
        vm.warp(t);
        uint64 c = coord.currentRound();
        assertEq(c, (t - GENESIS) / 3 + 1);
        // c is the latest round already due at t
        assertLe(coord.roundTimestamp(c), t);
        assertGt(coord.roundTimestamp(c + 1), t);
        assertEq(coord.maxRequestRound(), c + coord.MAX_ROUND_DELAY());
    }

    /// @notice SPEC section 2: the pinned round is published strictly more than one period after block.timestamp.
    function testFuzz_minRequestRound_safetyMargin(uint64 t) public {
        t = uint64(bound(t, GENESIS, type(uint32).max * uint64(8)));
        vm.warp(t);
        uint64 ts = coord.roundTimestamp(coord.minRequestRound());
        assertGt(ts, t + 3);
        assertLe(ts, t + 6);
    }

    function test_equalTimestamps_sameRoundDistinctIds() public {
        // Arc produces ~0.5s blocks, so several blocks share one timestamp.
        vm.prank(alice);
        (uint256 id1, uint64 r1) = coord.requestRandomness(0, 0);
        vm.roll(block.number + 1);
        vm.prank(bob);
        (uint256 id2, uint64 r2) = coord.requestRandomness(0, 0);
        vm.roll(block.number + 1);
        vm.prank(bob);
        (uint256 id3, uint64 r3) = coord.requestRandomness(0, 0);
        assertEq(r1, r2);
        assertEq(r2, r3);
        assertEq(id1 + 1, id2);
        assertEq(id2 + 1, id3);

        uint64 round = r1;
        assertGt(coord.roundTimestamp(round), block.timestamp + 3);
        warpToRound(round);
        vm.prank(relayer);
        coord.fulfill(id1, sigOf(round));
        vm.prank(relayer);
        coord.fulfill(id2, "");
        // Same round, different requests => different randomness.
        assertTrue(coord.getRequest(id1).randomness != coord.getRequest(id2).randomness);
    }

    // ================================================================ request

    function test_request_storesAndEmits() public {
        uint64 expectedRound = coord.minRequestRound();
        vm.expectEmit(address(coord));
        emit RandomnessRequested(1, alice, expectedRound, 0, 100_000);
        vm.prank(alice);
        (uint256 id, uint64 round) = coord.requestRandomness(100_000, 0);
        assertEq(id, 1);
        assertEq(round, expectedRound);
        IArcDrawCoordinator.Request memory r = coord.getRequest(id);
        assertEq(r.requester, alice);
        assertEq(r.round, round);
        assertEq(r.callbackGasLimit, 100_000);
        assertEq(uint8(r.status), uint8(IArcDrawCoordinator.Status.Pending));
        assertEq(r.bounty, 0);
        assertEq(r.createdAt, block.timestamp);
        assertEq(r.randomness, bytes32(0));
        assertEq(coord.expiresAt(id), coord.roundTimestamp(round) + 3600);
        assertEq(coord.requestCount(), 1);
    }

    function test_request_idsIncrementFromOne() public {
        for (uint256 i = 1; i <= 5; i++) {
            (uint256 id,) = coord.requestRandomness(0, 0);
            assertEq(id, i);
        }
    }

    function test_request_withBounty_pullsSixDecimalUsdc() public {
        uint96 bounty = uint96(ONE_USDC / 100); // 0.01 USDC = 10_000 units
        vm.prank(alice);
        coord.requestRandomness(0, bounty);
        assertEq(usdc.balanceOf(address(coord)), 10_000);
        assertEq(usdc.balanceOf(alice), 1_000 * ONE_USDC - 10_000);
        assertEq(coord.getRequest(1).bounty, 10_000);
    }

    function test_request_callbackGasLimitAtMax() public {
        coord.requestRandomness(500_000, 0);
    }

    function test_request_revert_callbackGasLimitTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IArcDrawCoordinator.CallbackGasLimitTooHigh.selector, uint32(500_001), uint32(500_000)
            )
        );
        coord.requestRandomness(500_001, 0);
    }

    function test_requestAtRound_revert_tooSoon() public {
        uint64 min = coord.minRequestRound();
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundTooSoon.selector, min - 1, min));
        coord.requestRandomnessAtRound(min - 1, 0, 0);
        uint64 current = coord.currentRound();
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundTooSoon.selector, current, min));
        coord.requestRandomnessAtRound(current, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundTooSoon.selector, uint64(0), min));
        coord.requestRandomnessAtRound(0, 0, 0);
    }

    function test_requestAtRound_revert_tooFar() public {
        uint64 max = coord.maxRequestRound();
        coord.requestRandomnessAtRound(max, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundTooFar.selector, max + 1, max));
        coord.requestRandomnessAtRound(max + 1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundTooFar.selector, type(uint64).max, max));
        coord.requestRandomnessAtRound(type(uint64).max, 0, 0);
    }

    function testFuzz_requestAtRound_inWindow(uint64 offset) public {
        uint64 min = coord.minRequestRound();
        uint64 round = uint64(bound(offset, min, coord.maxRequestRound()));
        uint256 id = coord.requestRandomnessAtRound(round, 0, 0);
        assertEq(coord.getRequest(id).round, round);
        assertEq(coord.expiresAt(id), GENESIS + (round - 1) * 3 + 3600);
    }

    function test_request_revert_insufficientAllowance() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, ONE_USDC);
        vm.prank(carol);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        coord.requestRandomness(0, 1);
    }

    function test_request_revert_blocklistedRequesterWithBounty() public {
        usdc.blacklist(alice, true);
        vm.prank(alice);
        vm.expectRevert("Blacklistable: account is blacklisted");
        coord.requestRandomness(0, 1);
        // Bounty 0 never touches USDC, so a blocklisted address can still request.
        vm.prank(alice);
        coord.requestRandomness(0, 0);
    }

    function test_request_revert_tokenReturnsFalse() public {
        usdc.setReturnFalse(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeUSDC.TokenTransferFailed.selector, ARC_USDC));
        coord.requestRandomness(0, 1);
    }

    function test_request_revert_tokenWithoutCode() public {
        ArcDrawCoordinator c = new ArcDrawCoordinator(makeAddr("no-code"));
        vm.expectRevert(abi.encodeWithSelector(SafeUSDC.TokenTransferFailed.selector, makeAddr("no-code")));
        c.requestRandomness(0, 1);
    }

    function test_getRequest_unknownIsNone() public view {
        assertEq(uint8(statusOf(42)), uint8(IArcDrawCoordinator.Status.None));
        assertEq(coord.expiresAt(42), 0);
    }

    // ================================================================ verifyRound

    function test_verifyRound_storesAndEmits() public {
        uint64 round = coord.currentRound();
        bytes memory sig = sigOf(round);
        vm.expectEmit(address(coord));
        emit RoundVerified(round, sha256(sig), sig);
        bytes32 d = coord.verifyRound(round, sig);
        assertEq(d, sha256(sig));
        assertEq(coord.roundRandomness(round), d);
    }

    function test_verifyRound_idempotentWithoutSignature() public {
        uint64 round = coord.currentRound();
        bytes32 d = coord.verifyRound(round, sigOf(round));
        vm.recordLogs();
        assertEq(coord.verifyRound(round, ""), d);
        assertEq(coord.verifyRound(round, hex"deadbeef"), d);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_verifyRound_revert_wrongLength() public {
        uint64 round = coord.currentRound();
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignatureLength.selector, uint256(47)));
        coord.verifyRound(round, new bytes(47));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignatureLength.selector, uint256(96)));
        coord.verifyRound(round, new bytes(96));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignatureLength.selector, uint256(0)));
        coord.verifyRound(round, "");
    }

    function test_verifyRound_revert_roundNotReached() public {
        uint64 next = coord.currentRound() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(IArcDrawCoordinator.RoundNotReached.selector, next, coord.roundTimestamp(next))
        );
        coord.verifyRound(next, sigOf(next));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.RoundNotReached.selector, uint64(0), GENESIS));
        coord.verifyRound(0, sigOf(0));
    }

    function test_verifyRound_atExactRoundTimestamp() public {
        uint64 next = coord.currentRound() + 1;
        warpToRound(next);
        coord.verifyRound(next, sigOf(next));
    }

    function test_verifyRound_revert_wrongSignature() public {
        uint64 round = coord.currentRound();
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.verifyRound(round, sigOf(round - 1));
    }

    function test_verifyRound_revert_nonCanonicalEncodings() public {
        uint64 round = coord.currentRound();
        bytes memory good = sigOf(round);

        bytes memory noCompression = bytes.concat(good);
        noCompression[0] = bytes1(uint8(noCompression[0]) & 0x7f);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.verifyRound(round, noCompression);

        bytes memory infinity = bytes.concat(good);
        infinity[0] = bytes1(uint8(infinity[0]) | 0x40);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.verifyRound(round, infinity);

        // x >= p: 0x1b.. > p_hi 0x1a01..
        bytes memory bigX = bytes.concat(good);
        bigX[0] = bytes1(uint8(0x9b));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.verifyRound(round, bigX);
    }

    // ================================================================ fulfill

    function _requestAndWarp(address who, uint32 gasLimit, uint96 bounty) internal returns (uint256 id, uint64 round) {
        vm.prank(who);
        (id, round) = coord.requestRandomness(gasLimit, bounty);
        warpToRound(round);
    }

    function test_fulfill_eoaRequester_paysBountyAndDerivesRandomness() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 100_000, 50_000);
        bytes memory sig = sigOf(round);
        bytes32 expected = expectedRandomness(sig, id);

        vm.expectEmit(address(coord));
        emit RoundVerified(round, sha256(sig), sig);
        vm.expectEmit(address(coord));
        emit RandomnessFulfilled(id, round, relayer, expected, 50_000, false); // EOA: no callback
        vm.prank(relayer);
        coord.fulfill(id, sig);

        IArcDrawCoordinator.Request memory r = coord.getRequest(id);
        assertEq(uint8(r.status), uint8(IArcDrawCoordinator.Status.Fulfilled));
        assertEq(r.randomness, expected);
        assertEq(r.bounty, 0);
        assertEq(usdc.balanceOf(relayer), 50_000);
        assertEq(usdc.balanceOf(address(coord)), 0);
    }

    function test_fulfill_revert_beforeRound() public {
        vm.prank(alice);
        (uint256 id, uint64 round) = coord.requestRandomness(0, 0);
        vm.warp(coord.roundTimestamp(round) - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IArcDrawCoordinator.RoundNotReached.selector, round, coord.roundTimestamp(round))
        );
        coord.fulfill(id, sigOf(round));
    }

    function test_fulfill_revert_unknownRequest() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IArcDrawCoordinator.RequestNotFulfillable.selector, uint256(7), IArcDrawCoordinator.Status.None
            )
        );
        coord.fulfill(7, "");
    }

    function test_fulfill_revert_twice() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 0);
        coord.fulfill(id, sigOf(round));
        vm.expectRevert(
            abi.encodeWithSelector(
                IArcDrawCoordinator.RequestNotFulfillable.selector, id, IArcDrawCoordinator.Status.Fulfilled
            )
        );
        coord.fulfill(id, sigOf(round));
    }

    function test_fulfill_revert_invalidSignature() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.fulfill(id, sigOf(round + 1));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignatureLength.selector, uint256(0)));
        coord.fulfill(id, "");
    }

    function test_fulfill_reusesVerifiedRound() public {
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 0);
        vm.prank(bob);
        (uint256 id2,) = coord.requestRandomness(0, 0);
        warpToRound(round);
        coord.fulfill(id1, sigOf(round));
        vm.recordLogs();
        coord.fulfill(id2, ""); // no signature needed
        assertEq(vm.getRecordedLogs().length, 1); // only RandomnessFulfilled, no second RoundVerified
        assertEq(coord.getRequest(id2).randomness, expectedRandomness(sigOf(round), id2));
    }

    function test_fulfill_revert_blocklistedFulfillerWithBounty_otherCanFulfill() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 1_000);
        usdc.blacklist(relayer, true);
        vm.prank(relayer);
        vm.expectRevert("Blacklistable: account is blacklisted");
        coord.fulfill(id, sigOf(round));
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Pending));
        vm.prank(bob);
        coord.fulfill(id, sigOf(round));
        assertEq(usdc.balanceOf(bob), 1_000 * ONE_USDC + 1_000);
    }

    function test_fulfill_bountyTransferReturnsFalse_reverts() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 1_000);
        usdc.setReturnFalse(true);
        vm.expectRevert(abi.encodeWithSelector(SafeUSDC.TokenTransferFailed.selector, ARC_USDC));
        coord.fulfill(id, sigOf(round));
    }

    function test_fulfill_derivationIsDomainSeparated() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 0);
        coord.fulfill(id, sigOf(round));
        bytes32 d = sha256(sigOf(round));
        bytes32 got = coord.getRequest(id).randomness;
        assertEq(got, keccak256(abi.encode(d, uint256(block.chainid), address(coord), id)));
        assertTrue(got != d);
        assertTrue(got != keccak256(abi.encode(d, uint256(5042002), address(coord), id)));
    }

    // ---------------------------------------------------------------- callbacks

    function test_callback_success() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        (uint256 id, uint64 round) = c.request(150_000, 0);
        warpToRound(round);
        bytes32 expected = expectedRandomness(sigOf(round), id);
        vm.expectEmit(address(coord));
        emit RandomnessFulfilled(id, round, relayer, expected, 0, true);
        vm.prank(relayer);
        coord.fulfill(id, sigOf(round));
        assertEq(c.calls(), 1);
        assertEq(c.lastRequestId(), id);
        assertEq(c.lastRandomness(), expected);
    }

    function test_callback_zeroGasLimit_notCalled() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        (uint256 id, uint64 round) = c.request(0, 0);
        warpToRound(round);
        coord.fulfill(id, sigOf(round));
        assertEq(c.calls(), 0);
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Fulfilled));
    }

    function test_callback_revert_doesNotRevertFulfillment() public {
        RevertingConsumer c = new RevertingConsumer(coord);
        usdc.mint(address(c), 10_000);
        (uint256 id, uint64 round) = c.request(100_000, 10_000);
        warpToRound(round);
        vm.expectEmit(address(coord));
        emit RandomnessFulfilled(id, round, relayer, expectedRandomness(sigOf(round), id), 10_000, false);
        vm.prank(relayer);
        coord.fulfill(id, sigOf(round));
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Fulfilled));
        assertEq(usdc.balanceOf(relayer), 10_000); // fulfiller still paid
    }

    function test_callback_outOfGas_doesNotRevertFulfillment() public {
        GasGuzzlerConsumer c = new GasGuzzlerConsumer(coord);
        (uint256 id, uint64 round) = c.request(300_000, 0);
        warpToRound(round);
        vm.prank(relayer);
        coord.fulfill{gas: 1_000_000}(id, sigOf(round));
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Fulfilled));
    }

    function test_callback_returnDataBomb_isNotCopied() public {
        ReturnDataBombConsumer c = new ReturnDataBombConsumer(coord);
        (uint256 id, uint64 round) = c.request(500_000, 0);
        warpToRound(round);
        uint256 g = gasleft();
        coord.fulfill{gas: 1_000_000}(id, sigOf(round));
        uint256 used = g - gasleft();
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Fulfilled));
        // Copying 100kB of returndata would cost far more than the callback budget.
        assertLt(used, 700_000);
    }

    function test_callback_revert_insufficientGas() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        (uint256 id, uint64 round) = c.request(500_000, 0);
        warpToRound(round);
        vm.expectPartialRevert(IArcDrawCoordinator.InsufficientGasForCallback.selector);
        coord.fulfill{gas: 300_000}(id, sigOf(round));
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Pending));
    }

    /// @notice A fulfiller can never get paid while giving the callback less than callbackGasLimit.
    function testFuzz_callback_cannotBeStarved(uint32 gasLimit, uint32 outerGas) public {
        gasLimit = uint32(bound(gasLimit, 30_000, 500_000));
        outerGas = uint32(bound(outerGas, 30_000, 800_000));
        GasProbeConsumer c = new GasProbeConsumer(coord);
        (uint256 id, uint64 round) = c.request(gasLimit);
        warpToRound(round);
        coord.verifyRound(round, sigOf(round)); // isolate the callback path from verification cost
        (bool ok,) = address(coord).call{gas: outerGas}(abi.encodeCall(coord.fulfill, (id, bytes(""))));
        if (ok) {
            assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Fulfilled));
            // gasleft() at entry is read after dispatch and the coordinator check (a few hundred gas)
            assertGt(c.gasAtEntry(), 0);
            assertGe(c.gasAtEntry() + 1_000, gasLimit);
        } else {
            assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Pending));
        }
    }

    function test_callback_reentrancyBlocked_fulfill() public {
        _reentry(ReentrantConsumer.Mode.Fulfill, true);
    }

    function test_callback_reentrancyBlocked_batch() public {
        _reentry(ReentrantConsumer.Mode.Batch, true);
    }

    function test_callback_reentrancyBlocked_refund() public {
        _reentry(ReentrantConsumer.Mode.Refund, true);
    }

    function test_callback_canRequestAgain() public {
        _reentry(ReentrantConsumer.Mode.Request, false);
    }

    function _reentry(ReentrantConsumer.Mode mode, bool expectBlocked) internal {
        ReentrantConsumer c = new ReentrantConsumer(coord);
        (uint256 id, uint64 round) = c.request(400_000, 0);
        c.request(0, 0); // id + 1, same round
        warpToRound(round + 1);
        c.setMode(mode, sigOf(round));
        coord.fulfill(id, sigOf(round));
        assertEq(c.calls(), 1);
        if (expectBlocked) {
            assertFalse(c.reentrySucceeded());
            assertEq(c.reentryRevert(), abi.encodeWithSelector(ArcDrawCoordinator.Reentrancy.selector));
            assertEq(uint8(statusOf(id + 1)), uint8(IArcDrawCoordinator.Status.Pending));
        } else {
            assertTrue(c.reentrySucceeded());
            assertEq(coord.requestCount(), 3);
        }
    }

    function test_consumer_rawFulfill_onlyCoordinator() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        vm.expectRevert(abi.encodeWithSelector(ArcDrawConsumer.OnlyCoordinator.selector, address(this)));
        c.rawFulfillRandomness(1, bytes32(uint256(1)));
    }

    // ================================================================ fulfillBatch

    function test_batch_fulfillsAllWithSingleTransfer() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 1_000);
        vm.prank(bob);
        (uint256 id2,) = coord.requestRandomness(0, 2_000);
        (uint256 id3,) = c.request(150_000, 0);
        warpToRound(round);

        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (id1, id2, id3);

        vm.prank(relayer);
        coord.fulfillBatch(round, sigOf(round), ids);

        assertEq(usdc.balanceOf(relayer), 3_000);
        assertEq(c.calls(), 1);
        for (uint256 i; i < 3; i++) {
            assertEq(uint8(statusOf(ids[i])), uint8(IArcDrawCoordinator.Status.Fulfilled));
            assertEq(coord.getRequest(ids[i]).randomness, expectedRandomness(sigOf(round), ids[i]));
        }
    }

    function test_batch_singleUsdcTransferEvent() public {
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 1_000);
        vm.prank(bob);
        (uint256 id2,) = coord.requestRandomness(0, 2_000);
        warpToRound(round);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id1, id2);
        vm.recordLogs();
        vm.prank(relayer);
        coord.fulfillBatch(round, sigOf(round), ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 transfers;
        uint256 fulfilled;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")) transfers++;
            if (logs[i].topics[0] == RandomnessFulfilled.selector) {
                assertEq(uint256(logs[i].topics[1]), ids[fulfilled]); // in order
                fulfilled++;
            }
        }
        assertEq(transfers, 1);
        assertEq(fulfilled, 2);
    }

    function test_batch_skipsAlreadyFulfilledAndDuplicates() public {
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 1_000);
        vm.prank(bob);
        (uint256 id2,) = coord.requestRandomness(0, 2_000);
        warpToRound(round);
        vm.prank(bob);
        coord.fulfill(id1, sigOf(round)); // a racing relayer wins id1

        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (id1, id2, id2, 999);
        vm.prank(relayer);
        coord.fulfillBatch(round, "", ids);
        assertEq(usdc.balanceOf(relayer), 2_000); // id2 paid once, id1 and unknown 999 skipped
        assertEq(uint8(statusOf(id2)), uint8(IArcDrawCoordinator.Status.Fulfilled));
    }

    function test_batch_revert_roundMismatch() public {
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 0);
        uint256 id2 = coord.requestRandomnessAtRound(round + 1, 0, 0);
        warpToRound(round + 1);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id1, id2);
        vm.expectRevert(
            abi.encodeWithSelector(IArcDrawCoordinator.RequestRoundMismatch.selector, id2, round + 1, round)
        );
        coord.fulfillBatch(round, sigOf(round), ids);
    }

    function test_batch_revert_invalidSignature() public {
        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, round));
        coord.fulfillBatch(round, sigOf(round - 1), ids);
    }

    function test_batch_emptyList_onlyVerifies() public {
        uint64 round = coord.currentRound();
        coord.fulfillBatch(round, sigOf(round), new uint256[](0));
        assertEq(coord.roundRandomness(round), sha256(sigOf(round)));
    }

    function test_batch_callbackFailureIsolated() public {
        RevertingConsumer bad = new RevertingConsumer(coord);
        RecordingConsumer good = new RecordingConsumer(coord);
        (uint256 id1, uint64 round) = bad.request(50_000, 0);
        (uint256 id2,) = good.request(150_000, 0);
        warpToRound(round);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id1, id2);
        coord.fulfillBatch(round, sigOf(round), ids);
        assertEq(good.calls(), 1);
        assertEq(uint8(statusOf(id1)), uint8(IArcDrawCoordinator.Status.Fulfilled));
    }

    // ================================================================ refund

    function test_refund_revert_beforeExpiry() public {
        vm.prank(alice);
        (uint256 id, uint64 round) = coord.requestRandomness(0, 5_000);
        uint64 expiry = coord.roundTimestamp(round) + 3600;
        vm.warp(expiry - 1);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.NotExpired.selector, id, expiry));
        coord.refund(id);
    }

    function test_refund_afterExpiry_thenLateFulfillStillRunsCallback() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        usdc.mint(address(c), 5_000);
        (uint256 id, uint64 round) = c.request(150_000, 5_000);
        vm.warp(coord.expiresAt(id));

        vm.expectEmit(address(coord));
        emit BountyRefunded(id, address(c), 5_000);
        vm.prank(bob); // permissionless
        coord.refund(id);
        assertEq(usdc.balanceOf(address(c)), 5_000);
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Refunded));
        assertEq(coord.getRequest(id).bounty, 0);
        assertEq(coord.refundedBounty(id), 5_000);

        vm.expectRevert(
            abi.encodeWithSelector(IArcDrawCoordinator.NotRefundable.selector, id, IArcDrawCoordinator.Status.Refunded)
        );
        coord.refund(id);

        // The outcome cannot be rerolled: late fulfillment delivers the same randomness, with no bounty.
        vm.expectEmit(address(coord));
        emit RandomnessFulfilled(id, round, relayer, expectedRandomness(sigOf(round), id), 0, true);
        vm.prank(relayer);
        coord.fulfill(id, sigOf(round));
        assertEq(c.calls(), 1);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(coord.refundedBounty(id), 5_000); // survives the late fulfillment
    }

    function test_refund_zeroBounty() public {
        vm.prank(alice);
        (uint256 id,) = coord.requestRandomness(0, 0);
        vm.warp(coord.expiresAt(id));
        coord.refund(id);
        assertEq(uint8(statusOf(id)), uint8(IArcDrawCoordinator.Status.Refunded));
        assertEq(coord.refundedBounty(id), 0);
    }

    function test_refund_revert_unknownAndFulfilled() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IArcDrawCoordinator.NotRefundable.selector, uint256(3), IArcDrawCoordinator.Status.None
            )
        );
        coord.refund(3);

        (uint256 id, uint64 round) = _requestAndWarp(alice, 0, 5_000);
        coord.fulfill(id, sigOf(round));
        vm.warp(block.timestamp + 7200);
        vm.expectRevert(
            abi.encodeWithSelector(IArcDrawCoordinator.NotRefundable.selector, id, IArcDrawCoordinator.Status.Fulfilled)
        );
        coord.refund(id);
    }

    function test_refund_blocklistedRequester_revertsButFulfillStillWorks() public {
        vm.prank(alice);
        (uint256 id, uint64 round) = coord.requestRandomness(0, 5_000);
        usdc.blacklist(alice, true);
        vm.warp(coord.expiresAt(id));
        vm.expectRevert("Blacklistable: account is blacklisted");
        coord.refund(id);
        vm.prank(relayer);
        coord.fulfill(id, sigOf(round));
        assertEq(usdc.balanceOf(relayer), 5_000);
    }

    function test_batch_refundedRequestPaysNoBounty() public {
        vm.prank(alice);
        (uint256 id1, uint64 round) = coord.requestRandomness(0, 1_000);
        vm.prank(bob);
        (uint256 id2,) = coord.requestRandomness(0, 2_000);
        vm.warp(coord.expiresAt(id1));
        coord.refund(id1);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id1, id2);
        vm.prank(relayer);
        coord.fulfillBatch(round, sigOf(round), ids);
        assertEq(usdc.balanceOf(relayer), 2_000);
        assertEq(usdc.balanceOf(alice), 1_000 * ONE_USDC);
    }

    // ================================================================ misc

    function test_noNativeValueAccepted() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(coord).call{value: 1}("");
        assertFalse(ok);
        vm.prank(alice);
        (ok,) = address(coord).call{value: 1}(abi.encodeCall(coord.requestRandomness, (0, 0)));
        assertFalse(ok);
    }
}
