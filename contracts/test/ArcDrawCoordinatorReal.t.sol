// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {IArcDrawCoordinator} from "../src/interfaces/IArcDrawCoordinator.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecordingConsumer} from "./mocks/Consumers.sol";
import {Quicknet} from "./fixtures/Quicknet.sol";

/// @notice The production coordinator (real BLS verification through EIP-2537) against real drand beacons.
contract ArcDrawCoordinatorRealTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    ArcDrawCoordinator coord;
    MockUSDC usdc;
    address relayer = makeAddr("relayer");

    function setUp() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(ARC_USDC);
        coord = new ArcDrawCoordinator(ARC_USDC);
        // First moment round 1000000 can be pinned: currentRound = 999996 (MIN_ROUND_DELAY = 4).
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A - 4));
        assertEq(coord.minRequestRound(), Quicknet.ROUND_A);
    }

    function test_realBeacon_fulfillWithCallbackAndBounty() public {
        RecordingConsumer c = new RecordingConsumer(coord);
        usdc.mint(address(c), 10_000);
        (uint256 id, uint64 round) = c.request(150_000, 10_000);
        assertEq(round, Quicknet.ROUND_A);

        vm.warp(coord.roundTimestamp(round));
        vm.prank(relayer);
        uint256 g = gasleft();
        coord.fulfill(id, Quicknet.SIG_A);
        console2.log("fulfill fresh round + callback + bounty, gas:", g - gasleft());

        assertEq(coord.roundRandomness(round), Quicknet.RAND_A); // equals drand's published randomness
        bytes32 expected = keccak256(abi.encode(Quicknet.RAND_A, block.chainid, address(coord), id));
        assertEq(coord.getRequest(id).randomness, expected);
        assertEq(c.lastRandomness(), expected);
        assertEq(usdc.balanceOf(relayer), 10_000);
    }

    function test_realBeacon_batchReusesVerifiedRound() public {
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            (ids[i],) = coord.requestRandomness(0, 0);
        }
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        coord.fulfillBatch(Quicknet.ROUND_A, Quicknet.SIG_A, ids);
        for (uint256 i; i < 3; i++) {
            assertEq(uint8(coord.getRequest(ids[i]).status), uint8(IArcDrawCoordinator.Status.Fulfilled));
        }
    }

    function test_realBeacon_allFixturesVerify() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_C));
        assertEq(coord.verifyRound(Quicknet.ROUND_A, Quicknet.SIG_A), Quicknet.RAND_A);
        assertEq(coord.verifyRound(Quicknet.ROUND_B, Quicknet.SIG_B), sha256(Quicknet.SIG_B));
        assertEq(coord.verifyRound(Quicknet.ROUND_C, Quicknet.SIG_C), Quicknet.RAND_C);
    }

    function test_realBeacon_wrongRoundRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_C));
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_B));
        coord.verifyRound(Quicknet.ROUND_B, Quicknet.SIG_A);
    }

    function test_realBeacon_flippedSignBitRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory bad = bytes.concat(Quicknet.SIG_A);
        bad[0] = bytes1(uint8(bad[0]) ^ 0x20); // the negated point
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound{gas: 5_000_000}(Quicknet.ROUND_A, bad);
    }

    function test_realBeacon_flippedPayloadBitRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory bad = bytes.concat(Quicknet.SIG_A);
        bad[47] = bytes1(uint8(bad[47]) ^ 0x01);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound{gas: 5_000_000}(Quicknet.ROUND_A, bad);
    }

    /// @notice x + p encodes the same point modulo p. It must be rejected, or sha256(signature) could be ground.
    function test_realBeacon_nonCanonicalXPlusPRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory sig = Quicknet.SIG_A;
        uint256 hi;
        uint256 lo;
        assembly {
            hi := shr(128, mload(add(sig, 0x20)))
            lo := mload(add(sig, 0x30))
        }
        uint256 flags = hi >> 125;
        hi &= (uint256(1) << 125) - 1;
        uint256 pHi = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
        uint256 pLo = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;
        uint256 newLo;
        unchecked {
            newLo = lo + pLo;
        }
        uint256 newHi = hi + pHi + (newLo < lo ? 1 : 0);
        assertLt(newHi, uint256(1) << 125, "x+p must still fit in 381 bits for this vector");
        bytes memory bad = abi.encodePacked(uint128((flags << 125) | newHi), newLo);
        assertEq(bad.length, 48);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound(Quicknet.ROUND_A, bad);
    }

    function test_realBeacon_infinityAndUncompressedFlagsRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory inf = bytes.concat(Quicknet.SIG_A);
        inf[0] = bytes1(uint8(inf[0]) | 0x40);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound(Quicknet.ROUND_A, inf);

        bytes memory canonicalInfinity = new bytes(48);
        canonicalInfinity[0] = 0xc0;
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound(Quicknet.ROUND_A, canonicalInfinity);

        bytes memory uncompressed = bytes.concat(Quicknet.SIG_A);
        uncompressed[0] = bytes1(uint8(uncompressed[0]) & 0x7f);
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
        coord.verifyRound(Quicknet.ROUND_A, uncompressed);
    }

    function test_realBeacon_xNotOnCurveRejected() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        // Small x values: some have no square root for x^3 + 4; all must be rejected.
        for (uint8 x = 1; x < 6; x++) {
            bytes memory bad = new bytes(48);
            bad[0] = 0x80;
            bad[47] = bytes1(x);
            vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_A));
            coord.verifyRound{gas: 5_000_000}(Quicknet.ROUND_A, bad);
        }
    }

    function test_gas_verifyRoundFresh() public {
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        uint256 g = gasleft();
        coord.verifyRound(Quicknet.ROUND_A, Quicknet.SIG_A);
        console2.log("verifyRound fresh, gas:", g - gasleft());
    }

    function test_sdkParityVector() public {
        vm.chainId(5042);
        assertEq(
            keccak256(abi.encode(Quicknet.RAND_A, block.chainid, Quicknet.VECTOR_COORDINATOR, uint256(1))),
            Quicknet.VECTOR_DERIVED
        );
    }
}
