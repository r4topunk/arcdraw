// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IArcDrawCoordinator} from "../../src/interfaces/IArcDrawCoordinator.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestCoordinator, fakeSignature} from "../mocks/TestCoordinator.sol";
import {RevertingConsumer, RecordingConsumer} from "../mocks/Consumers.sol";

contract CoordinatorHandler is Test {
    TestCoordinator public coord;
    MockUSDC public usdc;
    address[] public actors;
    RecordingConsumer public consumer;
    RevertingConsumer public badConsumer;

    uint256 public bountiesDeposited;
    uint256 public bountiesPaid;
    uint256 public bountiesRefunded;
    mapping(uint256 => bytes32) public randomnessAtFulfill;

    constructor(TestCoordinator coord_, MockUSDC usdc_) {
        coord = coord_;
        usdc = usdc_;
        for (uint256 i; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(a);
            usdc.mint(a, 1e12);
            vm.prank(a);
            usdc.approve(address(coord), type(uint256).max);
        }
        consumer = new RecordingConsumer(coord);
        badConsumer = new RevertingConsumer(coord);
        usdc.mint(address(consumer), 1e12);
        usdc.mint(address(badConsumer), 1e12);
    }

    function request(uint256 actorSeed, uint96 bounty, uint32 gasLimit, uint8 extraRounds) external {
        bounty = uint96(bound(bounty, 0, 10e6));
        uint64 round = coord.minRequestRound() + uint64(bound(extraRounds, 0, 20));
        uint256 kind = actorSeed % 6;
        if (kind == 4) {
            (bool ok,) =
                address(consumer).call(abi.encodeCall(consumer.request, (uint32(bound(gasLimit, 0, 200_000)), bounty)));
            require(ok);
        } else if (kind == 5) {
            (bool ok,) = address(badConsumer)
                .call(abi.encodeCall(badConsumer.request, (uint32(bound(gasLimit, 0, 200_000)), bounty)));
            require(ok);
        } else {
            vm.prank(actors[kind]);
            coord.requestRandomnessAtRound(round, 0, bounty);
        }
        bountiesDeposited += bounty;
    }

    function warp(uint16 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 7200));
        vm.roll(block.number + 1);
    }

    function fulfill(uint256 idSeed, uint256 fulfillerSeed) external {
        uint256 count = coord.requestCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        IArcDrawCoordinator.Request memory r = coord.getRequest(id);
        if (r.status != IArcDrawCoordinator.Status.Pending && r.status != IArcDrawCoordinator.Status.Refunded) return;
        if (block.timestamp < coord.roundTimestamp(r.round)) return;
        address f = actors[fulfillerSeed % actors.length];
        uint256 before = usdc.balanceOf(f);
        vm.prank(f);
        coord.fulfill(id, fakeSignature(r.round));
        bountiesPaid += usdc.balanceOf(f) - before;
        randomnessAtFulfill[id] = coord.getRequest(id).randomness;
    }

    function fulfillBatch(uint256 idSeed, uint8 len) external {
        uint256 count = coord.requestCount();
        if (count == 0) return;
        IArcDrawCoordinator.Request memory first = coord.getRequest(bound(idSeed, 1, count));
        if (block.timestamp < coord.roundTimestamp(first.round)) return;
        uint256 n = bound(len, 1, 8);
        uint256[] memory ids = new uint256[](n);
        uint256 found;
        for (uint256 id = 1; id <= count && found < n; id++) {
            if (coord.getRequest(id).round == first.round) ids[found++] = id;
        }
        assembly {
            mstore(ids, found)
        }
        uint256 before = usdc.balanceOf(address(this));
        coord.fulfillBatch(first.round, fakeSignature(first.round), ids);
        bountiesPaid += usdc.balanceOf(address(this)) - before;
        for (uint256 i; i < found; i++) {
            randomnessAtFulfill[ids[i]] = coord.getRequest(ids[i]).randomness;
        }
    }

    function refund(uint256 idSeed) external {
        uint256 count = coord.requestCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        IArcDrawCoordinator.Request memory r = coord.getRequest(id);
        if (r.status != IArcDrawCoordinator.Status.Pending || block.timestamp < coord.expiresAt(id)) return;
        coord.refund(id);
        bountiesRefunded += r.bounty;
    }
}

contract CoordinatorInvariantTest is Test {
    TestCoordinator coord;
    MockUSDC usdc;
    CoordinatorHandler handler;

    function setUp() public {
        address arcUsdc = 0x3600000000000000000000000000000000000000;
        vm.etch(arcUsdc, address(new MockUSDC()).code);
        usdc = MockUSDC(arcUsdc);
        coord = new TestCoordinator(arcUsdc);
        vm.warp(1_789_625_579);
        handler = new CoordinatorHandler(coord, usdc);
        targetContract(address(handler));
    }

    /// @notice USDC held by the coordinator == sum of bounties of Pending requests.
    function invariant_balanceEqualsPendingBounties() public view {
        uint256 sum;
        uint256 count = coord.requestCount();
        for (uint256 id = 1; id <= count; id++) {
            IArcDrawCoordinator.Request memory r = coord.getRequest(id);
            if (r.status == IArcDrawCoordinator.Status.Pending) sum += r.bounty;
            else assertEq(r.bounty, 0);
        }
        assertEq(usdc.balanceOf(address(coord)), sum);
        assertEq(handler.bountiesDeposited(), sum + handler.bountiesPaid() + handler.bountiesRefunded());
    }

    /// @notice A fulfilled request's randomness is exactly the domain-separated derivation of its pinned round,
    ///         and never changes afterwards.
    function invariant_randomnessFixedByRequest() public view {
        uint256 count = coord.requestCount();
        for (uint256 id = 1; id <= count; id++) {
            IArcDrawCoordinator.Request memory r = coord.getRequest(id);
            if (r.status == IArcDrawCoordinator.Status.Fulfilled) {
                bytes32 d = sha256(fakeSignature(r.round));
                assertEq(coord.roundRandomness(r.round), d);
                assertEq(r.randomness, keccak256(abi.encode(d, block.chainid, address(coord), id)));
                assertEq(r.randomness, handler.randomnessAtFulfill(id));
            } else {
                assertEq(r.randomness, bytes32(0));
                assertTrue(r.status != IArcDrawCoordinator.Status.None);
            }
        }
    }
}
