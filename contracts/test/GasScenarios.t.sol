// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {FairAllocation} from "../src/demo/FairAllocation.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Quicknet} from "./fixtures/Quicknet.sol";

/// @notice Gas scenarios with the production coordinator and real drand signatures.
///         Run with `forge test --isolate --match-contract GasScenariosTest` so every call is its own
///         transaction (cold storage, intrinsic gas included). Results: snapshots/ArcDrawGas.json -> docs/GAS.md.
contract GasScenariosTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    string constant GROUP = "ArcDrawGas";
    ArcDrawCoordinator coord;
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address relayer = makeAddr("relayer");

    /// @dev Only record with GAS_SNAPSHOT=true (set by script/gas-report.mjs, which also passes --isolate),
    ///      so a plain `forge test` never overwrites the file with warm-storage numbers.
    function _snap(string memory name) internal {
        if (vm.envOr("GAS_SNAPSHOT", false)) vm.snapshotGasLastCall(GROUP, name);
    }

    function setUp() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(ARC_USDC);
        coord = new ArcDrawCoordinator(ARC_USDC);
        usdc.mint(alice, 1_000e6);
        usdc.mint(relayer, 1e6); // non-zero balance, as a live relayer would have
        vm.prank(alice);
        usdc.approve(address(coord), type(uint256).max);
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A - 4));
    }

    function test_gas_request() public {
        vm.prank(alice);
        coord.requestRandomness(0, 0);
        _snap("requestRandomness_noBounty");
        vm.prank(alice);
        coord.requestRandomness(100_000, 10_000);
        _snap("requestRandomness_bounty");
    }

    function test_gas_fulfill_eoa() public {
        vm.prank(alice);
        (uint256 id1,) = coord.requestRandomness(0, 10_000);
        vm.prank(alice);
        (uint256 id2,) = coord.requestRandomness(0, 10_000);
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        vm.prank(relayer);
        coord.fulfill(id1, Quicknet.SIG_A);
        _snap("fulfill_freshRound_bounty_noCallback");
        vm.prank(relayer);
        coord.fulfill(id2, "");
        _snap("fulfill_verifiedRound_bounty_noCallback");
    }

    function test_gas_verifyRound() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        coord.verifyRound(Quicknet.ROUND_A, Quicknet.SIG_A);
        _snap("verifyRound_fresh");
    }

    function test_gas_fulfillBatch() public {
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; i++) {
            vm.prank(alice);
            (ids[i],) = coord.requestRandomness(0, 10_000);
        }
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        vm.prank(relayer);
        coord.fulfillBatch(Quicknet.ROUND_A, Quicknet.SIG_A, ids);
        _snap("fulfillBatch_freshRound_5ids_bounty_noCallback");
    }

    function test_gas_refund() public {
        vm.prank(alice);
        (uint256 id,) = coord.requestRandomness(0, 10_000);
        vm.warp(coord.expiresAt(id));
        coord.refund(id);
        _snap("refund_bounty");
    }

    function test_gas_fairAllocation() public {
        FairAllocation fa = new FairAllocation(coord);
        uint64 deadline = coord.roundTimestamp(Quicknet.ROUND_A - 4);
        vm.warp(deadline - 100);
        address creator = makeAddr("creator");
        usdc.mint(creator, 1e6);
        vm.prank(creator);
        usdc.approve(address(fa), type(uint256).max);
        vm.prank(creator);
        uint256 saleId = fa.createSale(creator, 100e6, 3, deadline, 10_000);
        _snap("fairAllocation_createSale_bounty");
        for (uint256 i; i < 5; i++) {
            address u = address(uint160(0x5000 + i));
            usdc.mint(u, 100e6);
            vm.prank(u);
            usdc.approve(address(fa), type(uint256).max);
            vm.prank(u);
            fa.subscribe(saleId);
            if (i == 1) _snap("fairAllocation_subscribe");
        }
        vm.warp(deadline); // subscriptions closed; pins round ROUND_A
        uint256 requestId = fa.draw(saleId);
        _snap("fairAllocation_draw");
        uint64 round = coord.getRequest(requestId).round;
        vm.warp(coord.roundTimestamp(round));
        assertEq(round, Quicknet.ROUND_A);
        vm.prank(relayer);
        coord.fulfill(requestId, Quicknet.SIG_A);
        _snap("fulfill_freshRound_bounty_fairAllocationCallback");
        fa.finalize(saleId);
        _snap("fairAllocation_finalize_N5_K3");
        fa.withdrawTreasury(saleId);
        _snap("fairAllocation_withdrawTreasury");
        address loser;
        for (uint256 i; i < 5; i++) {
            address u = address(uint160(0x5000 + i));
            if (!fa.isWinner(saleId, u)) loser = u;
        }
        vm.prank(loser);
        fa.claimRefund(saleId);
        _snap("fairAllocation_claimRefund");
    }
}
