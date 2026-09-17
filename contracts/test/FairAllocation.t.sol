// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/Test.sol";
import {BaseTest} from "./utils/BaseTest.sol";
import {FairAllocation} from "../src/demo/FairAllocation.sol";
import {ArcDrawConsumer} from "../src/ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "../src/interfaces/IArcDrawCoordinator.sol";

contract FairAllocationHarness is FairAllocation {
    constructor(IArcDrawCoordinator c) FairAllocation(c) {}

    function winnerBitmap(bytes32 seed, uint256 n, uint256 k) external pure returns (uint256[4] memory) {
        return _winnerBitmap(seed, n, k);
    }
}

contract FairAllocationTest is BaseTest {
    FairAllocationHarness fa;
    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");
    uint96 constant PRICE = 100e6; // 100 USDC, 6 decimals
    uint96 constant BOUNTY = 10_000; // 0.01 USDC

    event SeedReceived(uint256 indexed saleId, uint256 indexed requestId, bytes32 seed);
    event Finalized(uint256 indexed saleId, uint32 winners, uint256 raised);

    function setUp() public override {
        super.setUp();
        fa = new FairAllocationHarness(coord);
        usdc.mint(creator, 1_000e6);
        vm.prank(creator);
        usdc.approve(address(fa), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _create(uint32 slots, uint96 bounty) internal returns (uint256 saleId) {
        vm.prank(creator);
        saleId = fa.createSale(treasury, PRICE, slots, uint64(block.timestamp + 1 hours), bounty);
    }

    function _user(uint256 i) internal returns (address u) {
        u = address(uint160(0x10000 + i));
        usdc.mint(u, PRICE);
        vm.prank(u);
        usdc.approve(address(fa), type(uint256).max);
    }

    function _subscribeMany(uint256 saleId, uint256 n) internal returns (address[] memory users) {
        users = new address[](n);
        for (uint256 i; i < n; i++) {
            users[i] = _user(i);
            vm.prank(users[i]);
            fa.subscribe(saleId);
        }
    }

    function _drawAndFulfill(uint256 saleId) internal returns (uint256 requestId, uint64 round) {
        vm.warp(fa.getSale(saleId).subscribeDeadline);
        requestId = fa.draw(saleId);
        round = coord.getRequest(requestId).round;
        warpToRound(round);
        vm.prank(relayer);
        coord.fulfill(requestId, sigOf(round));
    }

    // ---------------------------------------------------------------- full flow

    function test_fullFlow_oversubscribed() public {
        uint256 saleId = _create(3, BOUNTY);
        assertEq(usdc.balanceOf(address(fa)), BOUNTY);
        address[] memory users = _subscribeMany(saleId, 5);
        assertEq(usdc.balanceOf(address(fa)), BOUNTY + 5 * PRICE);

        vm.expectRevert(
            abi.encodeWithSelector(
                FairAllocation.SubscriptionStillOpen.selector, saleId, uint64(block.timestamp + 1 hours)
            )
        );
        fa.draw(saleId);

        (uint256 requestId, uint64 round) = _drawAndFulfill(saleId);
        FairAllocation.Sale memory sale = fa.getSale(saleId);
        assertEq(uint8(sale.phase), uint8(FairAllocation.Phase.Drawn));
        assertEq(sale.seed, expectedRandomness(sigOf(round), requestId));
        assertEq(usdc.balanceOf(relayer), BOUNTY); // callback succeeded, fulfiller paid
        assertEq(fa.saleOfRequest(requestId), saleId);

        vm.expectEmit(address(fa));
        emit Finalized(saleId, 3, 3 * uint256(PRICE));
        fa.finalize(saleId);
        assertEq(usdc.balanceOf(treasury), 0); // pull-based
        assertEq(fa.treasuryOwed(saleId), 3 * uint256(PRICE));
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(treasury), 3 * PRICE);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NothingOwed.selector, saleId));
        fa.withdrawTreasury(saleId);

        uint256 winners;
        for (uint256 i; i < 5; i++) {
            if (fa.isWinner(saleId, users[i])) {
                winners++;
                vm.prank(users[i]);
                vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotEligibleForRefund.selector, saleId, users[i]));
                fa.claimRefund(saleId);
            } else {
                vm.prank(users[i]);
                fa.claimRefund(saleId);
                assertEq(usdc.balanceOf(users[i]), PRICE);
                assertTrue(fa.hasRefunded(saleId, users[i]));
                vm.prank(users[i]);
                vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotEligibleForRefund.selector, saleId, users[i]));
                fa.claimRefund(saleId);
            }
        }
        assertEq(winners, 3);
        assertEq(usdc.balanceOf(address(fa)), 0); // fully settled
    }

    function test_callbackGasIsEnough() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);
        uint64 round = coord.getRequest(requestId).round;
        warpToRound(round);
        // Mark storage cold, as in a fresh transaction on Arc, so the 60k callback budget is measured honestly.
        vm.cool(address(fa));
        vm.cool(address(coord));
        vm.expectEmit(address(coord));
        emit IArcDrawCoordinator.RandomnessFulfilled(
            requestId, round, address(this), expectedRandomness(sigOf(round), requestId), 0, true
        );
        coord.fulfill(requestId, sigOf(round));
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Drawn));
    }

    function test_notOversubscribed_finalizeWithoutRandomness() public {
        uint256 saleId = _create(5, BOUNTY);
        address[] memory users = _subscribeMany(saleId, 3);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotOversubscribed.selector, saleId));
        fa.draw(saleId);
        fa.finalize(saleId);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(treasury), 3 * PRICE);
        assertEq(fa.creatorOwed(saleId), BOUNTY);
        fa.withdrawCreatorBounty(saleId);
        assertEq(usdc.balanceOf(creator), 1_000e6); // bounty escrow returned
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NothingOwed.selector, saleId));
        fa.withdrawCreatorBounty(saleId);
        assertTrue(fa.bountyReclaimed(saleId));
        for (uint256 i; i < 3; i++) {
            assertTrue(fa.isWinner(saleId, users[i]));
            vm.prank(users[i]);
            vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotEligibleForRefund.selector, saleId, users[i]));
            fa.claimRefund(saleId);
        }
        assertEq(usdc.balanceOf(address(fa)), 0);
        assertEq(coord.requestCount(), 0);
    }

    function test_exactlyKSubscribers_allWin() public {
        uint256 saleId = _create(3, 0);
        _subscribeMany(saleId, 3);
        vm.warp(block.timestamp + 1 hours);
        fa.finalize(saleId);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(treasury), 3 * PRICE);
    }

    function test_zeroSubscribers() public {
        uint256 saleId = _create(3, BOUNTY);
        vm.warp(block.timestamp + 1 hours);
        fa.finalize(saleId);
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Finalized));
        assertEq(fa.treasuryOwed(saleId), 0);
        fa.withdrawCreatorBounty(saleId);
        assertEq(usdc.balanceOf(creator), 1_000e6);
    }

    // ---------------------------------------------------------------- reverts

    function test_createSale_revert_invalidParams() public {
        uint64 dl = uint64(block.timestamp + 1);
        vm.startPrank(creator);
        vm.expectRevert(FairAllocation.InvalidSaleParams.selector);
        fa.createSale(address(0), PRICE, 1, dl, 0);
        vm.expectRevert(FairAllocation.InvalidSaleParams.selector);
        fa.createSale(treasury, 0, 1, dl, 0);
        vm.expectRevert(FairAllocation.InvalidSaleParams.selector);
        fa.createSale(treasury, PRICE, 0, dl, 0);
        vm.expectRevert(FairAllocation.InvalidSaleParams.selector);
        fa.createSale(treasury, PRICE, 1, uint64(block.timestamp), 0);
        vm.stopPrank();
    }

    function test_subscribe_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.WrongPhase.selector, 99, FairAllocation.Phase.None));
        fa.subscribe(99);

        uint256 saleId = _create(1, 0);
        address u = _user(1);
        usdc.mint(u, PRICE);
        vm.startPrank(u);
        fa.subscribe(saleId);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.AlreadySubscribed.selector, saleId, u));
        fa.subscribe(saleId);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 hours); // deadline is exclusive
        address v = _user(2);
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.SubscriptionClosed.selector, saleId));
        fa.subscribe(saleId);
    }

    function test_subscribe_revert_insufficientBalance() public {
        uint256 saleId = _create(1, 0);
        address poor = makeAddr("poor");
        usdc.mint(poor, PRICE - 1); // 99.999999 USDC
        vm.prank(poor);
        usdc.approve(address(fa), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        fa.subscribe(saleId);
        assertEq(fa.participantCount(saleId), 0);
    }

    function test_subscribe_revert_blocklisted() public {
        uint256 saleId = _create(1, 0);
        address u = _user(1);
        usdc.blacklist(u, true);
        vm.prank(u);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.subscribe(saleId);
    }

    function test_subscribe_revert_saleFull() public {
        uint256 saleId = _create(10, 0);
        _subscribeMany(saleId, 1000);
        address late = _user(5000);
        vm.prank(late);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.SaleFull.selector, saleId));
        fa.subscribe(saleId);
    }

    function test_phaseReverts() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Open));
        fa.claimRefund(saleId);
        vm.expectRevert(
            abi.encodeWithSelector(
                FairAllocation.SubscriptionStillOpen.selector, saleId, uint64(block.timestamp + 1 hours)
            )
        );
        fa.finalize(saleId);

        vm.warp(block.timestamp + 1 hours);
        // Oversubscribed: must draw before finalize.
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Open));
        fa.finalize(saleId);

        fa.draw(saleId);
        vm.expectRevert(
            abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Drawing)
        );
        fa.draw(saleId);
        vm.expectRevert(
            abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Drawing)
        );
        fa.finalize(saleId);
        vm.expectRevert(
            abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Drawing)
        );
        fa.subscribe(saleId);
    }

    function test_finalizeTwice_reverts() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        _drawAndFulfill(saleId);
        fa.finalize(saleId);
        vm.expectRevert(
            abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Finalized)
        );
        fa.finalize(saleId);
    }

    function test_claimRefund_revert_nonParticipant() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        _drawAndFulfill(saleId);
        fa.finalize(saleId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotEligibleForRefund.selector, saleId, bob));
        fa.claimRefund(saleId);
        assertFalse(fa.isWinner(saleId, bob));
    }

    function test_blocklistedLoser_doesNotBlockOthers() public {
        uint256 saleId = _create(1, 0);
        address[] memory users = _subscribeMany(saleId, 3);
        _drawAndFulfill(saleId);
        fa.finalize(saleId);
        address[] memory losers = new address[](2);
        uint256 l;
        for (uint256 i; i < 3; i++) {
            if (!fa.isWinner(saleId, users[i])) losers[l++] = users[i];
        }
        usdc.blacklist(losers[0], true);
        vm.prank(losers[0]);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.claimRefund(saleId);
        vm.prank(losers[1]);
        fa.claimRefund(saleId);
        assertEq(usdc.balanceOf(losers[1]), PRICE);
    }

    // ---------------------------------------------------------------- callback safety

    function test_callback_onlyCoordinator() public {
        vm.expectRevert(abi.encodeWithSelector(ArcDrawConsumer.OnlyCoordinator.selector, address(this)));
        fa.rawFulfillRandomness(1, bytes32(uint256(1)));
    }

    function test_callback_unknownRequestIgnored() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        vm.prank(address(coord));
        fa.rawFulfillRandomness(12345, bytes32(uint256(1)));
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Open));
    }

    // ---------------------------------------------------------------- permit

    function test_subscribeWithPermit() public {
        uint256 saleId = _create(1, 0);
        (address u, uint256 pk) = makeAddrAndKey("permit-user");
        usdc.mint(u, PRICE);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(u, pk, PRICE, block.timestamp + 1 hours);
        vm.prank(u);
        fa.subscribeWithPermit(saleId, block.timestamp + 1 hours, v, r, s);
        assertEq(fa.participantCount(saleId), 1);
        assertEq(usdc.balanceOf(u), 0);
    }

    function test_subscribeWithPermit_frontRunPermitStillSubscribes() public {
        uint256 saleId = _create(1, 0);
        (address u, uint256 pk) = makeAddrAndKey("permit-user");
        usdc.mint(u, PRICE);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(u, pk, PRICE, dl);
        usdc.permit(u, address(fa), PRICE, dl, v, r, s); // griefer submits the permit first
        vm.prank(u);
        fa.subscribeWithPermit(saleId, dl, v, r, s);
        assertEq(fa.participantCount(saleId), 1);
    }

    function test_subscribeWithPermit_revert_badPermit() public {
        uint256 saleId = _create(1, 0);
        (address u,) = makeAddrAndKey("permit-user");
        usdc.mint(u, PRICE);
        vm.prank(u);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        fa.subscribeWithPermit(saleId, block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function _permitSig(address owner, uint256 pk, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), owner, address(fa), value, usdc.nonces(owner), deadline))
            )
        );
        return vm.sign(pk, digest);
    }

    // ---------------------------------------------------------------- bounty refund path

    function test_reclaimBounty_afterCoordinatorRefund_thenLateDraw() public {
        uint256 saleId = _create(1, BOUNTY);
        address[] memory users = _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);

        vm.expectRevert(abi.encodeWithSelector(FairAllocation.BountyNotReclaimable.selector, saleId));
        fa.reclaimBounty(saleId);

        vm.warp(coord.expiresAt(requestId));
        coord.refund(requestId);
        assertEq(usdc.balanceOf(address(fa)), BOUNTY + 2 * PRICE);
        fa.reclaimBounty(saleId);
        assertEq(usdc.balanceOf(creator), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.BountyNotReclaimable.selector, saleId));
        fa.reclaimBounty(saleId);

        // Late fulfillment still completes the draw: no reroll.
        uint64 round = coord.getRequest(requestId).round;
        coord.fulfill(requestId, sigOf(round));
        fa.finalize(saleId);
        uint256 w = (fa.isWinner(saleId, users[0]) ? 1 : 0) + (fa.isWinner(saleId, users[1]) ? 1 : 0);
        assertEq(w, 1);
    }

    function test_reclaimBounty_revert_noDraw() public {
        uint256 saleId = _create(1, BOUNTY);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.BountyNotReclaimable.selector, saleId));
        fa.reclaimBounty(saleId);
    }

    // ---------------------------------------------------------------- blocklisted payees (pull payments)

    function test_blocklistedTreasury_doesNotBlockRefunds() public {
        uint256 saleId = _create(1, 0);
        address[] memory users = _subscribeMany(saleId, 3);
        _drawAndFulfill(saleId);
        usdc.blacklist(treasury, true);
        fa.finalize(saleId); // does not revert
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Finalized));
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.withdrawTreasury(saleId);
        for (uint256 i; i < 3; i++) {
            if (fa.isWinner(saleId, users[i])) continue;
            vm.prank(users[i]);
            fa.claimRefund(saleId);
            assertEq(usdc.balanceOf(users[i]), PRICE);
        }
        assertEq(fa.treasuryOwed(saleId), PRICE); // still credited, payable once unblocked
        usdc.blacklist(treasury, false);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(address(fa)), 0);
    }

    function test_blocklistedCreator_doesNotBlockFinalize() public {
        uint256 saleId = _create(5, BOUNTY);
        _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        usdc.blacklist(creator, true);
        fa.finalize(saleId);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(treasury), 2 * PRICE);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.withdrawCreatorBounty(saleId);
    }

    /// @notice L2: a treasury blocklisted for good does not lock the proceeds; the creator redirects them.
    function test_blocklistedTreasury_creatorRedirectsProceeds() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 3);
        _drawAndFulfill(saleId);
        fa.finalize(saleId);
        usdc.blacklist(treasury, true);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.withdrawTreasury(saleId);

        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(fa));
        emit FairAllocation.TreasuryUpdated(saleId, newTreasury);
        vm.prank(creator);
        fa.setTreasury(saleId, newTreasury);
        assertEq(fa.getSale(saleId).treasury, newTreasury);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(newTreasury), PRICE);
        assertEq(fa.treasuryOwed(saleId), 0);
    }

    /// @notice L2: a blocklisted creator (who can still send transactions) redirects its bounty payouts.
    function test_blocklistedCreator_payeeReceivesUnusedBounty() public {
        uint256 saleId = _create(5, BOUNTY);
        _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        fa.finalize(saleId);
        usdc.blacklist(creator, true);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.withdrawCreatorBounty(saleId);

        address payee = makeAddr("payee");
        vm.prank(creator);
        fa.setCreatorPayee(saleId, payee);
        assertEq(fa.creatorPayee(saleId), payee);
        fa.withdrawCreatorBounty(saleId);
        assertEq(usdc.balanceOf(payee), BOUNTY);
        fa.withdrawTreasury(saleId);
        assertEq(usdc.balanceOf(address(fa)), 0);
    }

    function test_blocklistedCreator_payeeReceivesRefundedBounty() public {
        uint256 saleId = _create(1, BOUNTY);
        _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);
        vm.warp(coord.expiresAt(requestId));
        coord.refund(requestId);
        usdc.blacklist(creator, true);
        vm.expectRevert("Blacklistable: account is blacklisted");
        fa.reclaimBounty(saleId);

        address payee = makeAddr("payee");
        vm.prank(creator);
        fa.setCreatorPayee(saleId, payee);
        fa.reclaimBounty(saleId);
        assertEq(usdc.balanceOf(payee), BOUNTY);
    }

    function test_setPayees_onlyCreator_nonZero() public {
        uint256 saleId = _create(1, 0);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotCreator.selector, saleId, bob));
        vm.prank(bob);
        fa.setTreasury(saleId, bob);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotCreator.selector, saleId, bob));
        vm.prank(bob);
        fa.setCreatorPayee(saleId, bob);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.InvalidSaleParams.selector));
        vm.prank(creator);
        fa.setTreasury(saleId, address(0));
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.InvalidSaleParams.selector));
        vm.prank(creator);
        fa.setCreatorPayee(saleId, address(0));
        // unknown sale: nobody is its creator
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotCreator.selector, 99, address(0)));
        vm.prank(address(0));
        fa.setTreasury(99, bob);
    }

    // ---------------------------------------------------------------- stuck draw recovery

    function test_syncSeed_afterFailedCallback() public {
        uint256 saleId = _create(1, 0);
        address[] memory users = _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);
        uint64 round = coord.getRequest(requestId).round;
        warpToRound(round);

        vm.expectRevert(abi.encodeWithSelector(FairAllocation.RequestNotFulfilled.selector, saleId, requestId));
        fa.syncSeed(saleId);

        // Force the callback to fail: the consumer reverts, the coordinator still marks the request Fulfilled.
        vm.mockCallRevert(address(fa), abi.encodeWithSelector(fa.rawFulfillRandomness.selector), "boom");
        vm.expectEmit(address(coord));
        emit IArcDrawCoordinator.RandomnessFulfilled(
            requestId, round, address(this), expectedRandomness(sigOf(round), requestId), 0, false
        );
        coord.fulfill(requestId, sigOf(round));
        vm.clearMockedCalls();
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Drawing));

        fa.syncSeed(saleId);
        FairAllocation.Sale memory sale = fa.getSale(saleId);
        assertEq(uint8(sale.phase), uint8(FairAllocation.Phase.Drawn));
        assertEq(sale.seed, expectedRandomness(sigOf(round), requestId));
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Drawn));
        fa.syncSeed(saleId);

        fa.finalize(saleId);
        uint256 w = (fa.isWinner(saleId, users[0]) ? 1 : 0) + (fa.isWinner(saleId, users[1]) ? 1 : 0);
        assertEq(w, 1);
    }

    function test_cancelStuckDraw_refundsEveryone() public {
        uint256 saleId = _create(1, BOUNTY);
        address[] memory users = _subscribeMany(saleId, 3);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);
        uint64 round = coord.getRequest(requestId).round;
        uint64 cancellableAt = coord.roundTimestamp(round) + fa.DRAW_TIMEOUT();

        vm.warp(cancellableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.DrawNotTimedOut.selector, saleId, cancellableAt));
        fa.cancelStuckDraw(saleId);

        vm.warp(cancellableAt);
        fa.cancelStuckDraw(saleId);
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Cancelled));
        vm.expectRevert(
            abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Cancelled)
        );
        fa.finalize(saleId);

        for (uint256 i; i < 3; i++) {
            vm.prank(users[i]);
            fa.claimRefund(saleId);
            assertEq(usdc.balanceOf(users[i]), PRICE);
            assertFalse(fa.isWinner(saleId, users[i]));
        }
        vm.prank(users[0]);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.NotEligibleForRefund.selector, saleId, users[0]));
        fa.claimRefund(saleId);

        // A late fulfillment is ignored by the cancelled sale; the escrowed bounty returns through the coordinator.
        coord.refund(requestId);
        coord.fulfill(requestId, sigOf(round));
        assertEq(uint8(fa.getSale(saleId).phase), uint8(FairAllocation.Phase.Cancelled));
        fa.reclaimBounty(saleId);
        assertEq(usdc.balanceOf(creator), 1_000e6);
        assertEq(usdc.balanceOf(address(fa)), 0);
    }

    function test_cancelStuckDraw_revert_whenFulfilled() public {
        uint256 saleId = _create(1, 0);
        _subscribeMany(saleId, 2);
        (, uint64 round) = _drawAndFulfill(saleId);
        vm.warp(coord.roundTimestamp(round) + fa.DRAW_TIMEOUT());
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.WrongPhase.selector, saleId, FairAllocation.Phase.Drawn));
        fa.cancelStuckDraw(saleId);
    }

    function test_reclaimBounty_afterLateFulfillLandsFirst() public {
        uint256 saleId = _create(1, BOUNTY);
        _subscribeMany(saleId, 2);
        vm.warp(block.timestamp + 1 hours);
        uint256 requestId = fa.draw(saleId);
        vm.warp(coord.expiresAt(requestId));
        coord.refund(requestId);
        uint64 round = coord.getRequest(requestId).round;
        coord.fulfill(requestId, sigOf(round)); // late fulfill before anyone reclaims
        fa.reclaimBounty(saleId);
        assertEq(usdc.balanceOf(creator), 1_000e6);
        fa.finalize(saleId);
        fa.withdrawTreasury(saleId);
    }

    function test_reclaimBounty_revert_whenBountyWasPaid() public {
        uint256 saleId = _create(1, BOUNTY);
        _subscribeMany(saleId, 2);
        _drawAndFulfill(saleId);
        vm.expectRevert(abi.encodeWithSelector(FairAllocation.BountyNotReclaimable.selector, saleId));
        fa.reclaimBounty(saleId);
    }

    // ---------------------------------------------------------------- selection properties

    function testFuzz_winnerBitmap_exactlyKDistinctInRange(bytes32 seed, uint16 n, uint16 k) public view {
        n = uint16(bound(n, 2, 1000));
        k = uint16(bound(k, 1, n - 1));
        uint256[4] memory bits = fa.winnerBitmap(seed, n, k);
        uint256 count;
        for (uint256 i; i < 1000; i++) {
            if (bits[i >> 8] & (uint256(1) << (i & 0xff)) != 0) {
                assertLt(i, n);
                count++;
            }
        }
        assertEq(count, k);
    }

    /// @notice Chi-square-lite uniformity: N=10, K=3 over 3000 seeds; each index expected 900 times.
    function test_winnerBitmap_uniformDistribution() public view {
        uint256 n = 10;
        uint256 k = 3;
        uint256 runs = 3000;
        uint256[10] memory hits;
        for (uint256 s; s < runs; s++) {
            uint256 b = fa.winnerBitmap(keccak256(abi.encode("seed", s)), n, k)[0];
            for (uint256 i; i < n; i++) {
                if (b & (1 << i) != 0) hits[i]++;
            }
        }
        uint256 expected = runs * k / n; // 900
        uint256 chi2x100; // sum((o-e)^2/e) * 100
        for (uint256 i; i < n; i++) {
            uint256 d = hits[i] > expected ? hits[i] - expected : expected - hits[i];
            chi2x100 += d * d * 100 / expected;
            assertApproxEqRel(hits[i], expected, 0.12e18);
        }
        // 9 degrees of freedom: p = 0.001 critical value is 27.88
        assertLt(chi2x100, 2788);
    }

    function testFuzz_accountingSettlesToZero(uint8 nSeed, uint8 kSeed, uint96 price) public {
        uint256 n = bound(nSeed, 0, 40);
        uint32 k = uint32(bound(kSeed, 1, 20));
        price = uint96(bound(price, 1, 1_000e6));
        vm.prank(creator);
        uint256 saleId = fa.createSale(treasury, price, k, uint64(block.timestamp + 1 hours), BOUNTY);
        address[] memory users = new address[](n);
        for (uint256 i; i < n; i++) {
            users[i] = address(uint160(0x20000 + i));
            usdc.mint(users[i], price);
            vm.startPrank(users[i]);
            usdc.approve(address(fa), price);
            fa.subscribe(saleId);
            vm.stopPrank();
        }
        assertEq(usdc.balanceOf(address(fa)), BOUNTY + n * uint256(price));
        vm.warp(block.timestamp + 1 hours);
        if (n > k) _drawAndFulfill(saleId);
        fa.finalize(saleId);
        if (fa.treasuryOwed(saleId) > 0) fa.withdrawTreasury(saleId);
        if (fa.creatorOwed(saleId) > 0) fa.withdrawCreatorBounty(saleId);
        uint256 winners;
        for (uint256 i; i < n; i++) {
            if (fa.isWinner(saleId, users[i])) {
                winners++;
            } else {
                vm.prank(users[i]);
                fa.claimRefund(saleId);
            }
        }
        assertEq(winners, n > k ? k : n);
        assertEq(usdc.balanceOf(treasury), winners * price);
        assertEq(usdc.balanceOf(address(fa)), 0);
    }

    // ---------------------------------------------------------------- gas

    function test_gas_finalize_N1000_K100() public {
        uint256 saleId = _create(100, 0);
        _subscribeMany(saleId, 1000);
        _drawAndFulfill(saleId);
        uint256 g = gasleft();
        fa.finalize(saleId);
        console2.log("finalize N=1000 K=100, gas:", g - gasleft());
    }

    function test_gas_finalize_N1000_K999() public {
        uint256 saleId = _create(999, 0);
        _subscribeMany(saleId, 1000);
        _drawAndFulfill(saleId);
        uint256 g = gasleft();
        fa.finalize(saleId);
        console2.log("finalize N=1000 K=999, gas:", g - gasleft());
    }
}
