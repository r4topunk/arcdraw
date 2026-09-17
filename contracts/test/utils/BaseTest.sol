// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestCoordinator, fakeSignature} from "../mocks/TestCoordinator.sol";
import {IArcDrawCoordinator} from "../../src/interfaces/IArcDrawCoordinator.sol";

abstract contract BaseTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint64 internal constant GENESIS = 1692803367;
    uint256 internal constant ONE_USDC = 1e6; // 6 decimals on the ERC-20 interface

    MockUSDC internal usdc;
    TestCoordinator internal coord;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");

    function setUp() public virtual {
        // Arc USDC lives at 0x3600..; tests put a 6-decimal mock with a blocklist at the same address.
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(ARC_USDC);
        coord = new TestCoordinator(ARC_USDC);
        vm.warp(1_789_625_579); // Arc mainnet block timestamp, 2026-09-17
        usdc.mint(alice, 1_000 * ONE_USDC);
        usdc.mint(bob, 1_000 * ONE_USDC);
        vm.prank(alice);
        usdc.approve(address(coord), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(coord), type(uint256).max);
    }

    function roundTs(uint64 round) internal pure returns (uint64) {
        return GENESIS + (round - 1) * 3;
    }

    function warpToRound(uint64 round) internal {
        vm.warp(roundTs(round));
    }

    function sigOf(uint64 round) internal pure returns (bytes memory) {
        return fakeSignature(round);
    }

    function statusOf(uint256 id) internal view returns (IArcDrawCoordinator.Status) {
        return coord.getRequest(id).status;
    }

    function expectedRandomness(bytes memory sig, uint256 id) internal view returns (bytes32) {
        return keccak256(abi.encode(sha256(sig), block.chainid, address(coord), id));
    }
}
