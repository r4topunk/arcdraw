// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {BaseTest} from "./utils/BaseTest.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {IArcDrawCoordinator} from "../src/interfaces/IArcDrawCoordinator.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {SimDivergentConsumer} from "./mocks/Consumers.sol";
import {Quicknet} from "./fixtures/Quicknet.sol";

/// @notice Mirror of `worstCaseFulfillBatchGas` in packages/sdk/src/gas.ts (keep the constants in sync).
library WorstCaseGas {
    uint256 internal constant BASE = 80_000;
    uint256 internal constant VERIFY_ROUND = 250_000;
    uint256 internal constant PER_REQUEST = 40_000;
    uint256 internal constant CALLBACK_OVERHEAD = 5_000;
    uint256 internal constant COORDINATOR_CALLBACK_RESERVE = 5_000;

    function batch(bool freshRound, uint32[] memory callbackGasLimits) internal pure returns (uint256 gas) {
        gas = BASE + (freshRound ? VERIFY_ROUND : 0);
        for (uint256 i; i < callbackGasLimits.length; ++i) {
            uint256 cb = callbackGasLimits[i];
            gas += PER_REQUEST;
            if (cb > 0) gas += cb + cb / 63 + COORDINATOR_CALLBACK_RESERVE + CALLBACK_OVERHEAD;
        }
    }

    /// @dev The bound is for a whole transaction; a test call only gets the execution part.
    function executionAllowance(uint256 txGas, bytes memory data) internal pure returns (uint256) {
        uint256 intrinsic = 21_000;
        for (uint256 i; i < data.length; ++i) {
            intrinsic += data[i] == 0 ? 4 : 16;
        }
        return txGas - intrinsic;
    }
}

/// @notice Audit R1 regression (PoC ported from the pre-mainnet audit). A consumer that is cheap in simulation
///         (tx.gasprice == 0) makes an estimate-based gas limit revert onchain forever; the simulation-independent
///         worst-case limit used by the relayer fulfills the same batch.
contract FulfillBatchGasLimitTest is BaseTest {
    function _batchOk(uint64 round, uint256[] memory ids, uint256 g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(coord).call{gas: g}(abi.encodeCall(coord.fulfillBatch, (round, sigOf(round), ids)));
    }

    function _divergentBatch() internal returns (uint256[] memory ids, uint64 round, SimDivergentConsumer evil) {
        evil = new SimDivergentConsumer(coord);
        (uint256 idA, uint64 r) = evil.request(500_000, 0);
        (uint256 idB,) = evil.request(500_000, 0);
        // an honest request on the same round, with a bounty
        vm.prank(alice);
        (uint256 idH,) = coord.requestRandomness(0, uint96(ONE_USDC / 100));
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (idA, idB, idH);
        round = r;
        warpToRound(round);
    }

    /// @dev Binary search for the smallest gas that succeeds with tx.gasprice == 0, like eth_estimateGas.
    function _estimate(uint64 round, uint256[] memory ids) internal returns (uint256) {
        vm.txGasPrice(0);
        uint256 lo = 100_000;
        uint256 hi = 5_000_000;
        uint256 snap = vm.snapshotState();
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _batchOk(round, ids, mid);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// Relayer flow before the fix: estimate (gasprice 0) -> +20% buffer -> send at 20 gwei -> revert, ids stay pending.
    function test_poc_relayerBatchRevertLoop() public {
        (uint256[] memory ids, uint64 round,) = _divergentBatch();
        uint256 est = _estimate(round, ids);
        uint256 limit = est + est * 20 / 100;
        emit log_named_uint("estimate", est);
        emit log_named_uint("relayer gas limit", limit);

        vm.txGasPrice(20 gwei);
        uint256 g0 = gasleft();
        (bool ok2, bytes memory ret) = _batchOk(round, ids, limit);
        emit log_named_uint("gas burnt by reverted tx", g0 - gasleft());
        assertFalse(ok2, "real tx should revert");
        assertEq(bytes4(ret), IArcDrawCoordinator.InsufficientGasForCallback.selector);
        // nothing changed: every tick the relayer re-simulates (passes) and resends (reverts)
        assertEq(uint8(statusOf(ids[2])), uint8(IArcDrawCoordinator.Status.Pending));
    }

    /// The fix: the worst-case limit does not depend on what the callbacks do in simulation.
    function test_worstCaseLimit_fulfillsSimDivergentBatch() public {
        (uint256[] memory ids, uint64 round, SimDivergentConsumer evil) = _divergentBatch();
        uint32[] memory cbs = new uint32[](3);
        (cbs[0], cbs[1], cbs[2]) = (500_000, 500_000, 0);
        uint256 txGas = WorstCaseGas.batch(true, cbs);
        bytes memory data = abi.encodeCall(coord.fulfillBatch, (round, sigOf(round), ids));

        vm.txGasPrice(20 gwei);
        vm.prank(relayer);
        (bool ok,) = address(coord).call{gas: WorstCaseGas.executionAllowance(txGas, data)}(data);
        assertTrue(ok, "worst-case limit must fulfill the batch");
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(statusOf(ids[i])), uint8(IArcDrawCoordinator.Status.Fulfilled));
        }
        assertEq(evil.calls(), 0); // both callbacks ran out of gas: recorded, not bubbled
        assertEq(usdc.balanceOf(relayer), ONE_USDC / 100);
    }
}

/// @notice The worst-case bound holds against the production coordinator (real BLS through EIP-2537, real beacons),
///         for batches mixing EOA requests with bounties and consumers that burn their full callback budget.
contract FulfillBatchGasLimitRealTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    ArcDrawCoordinator coord;
    MockUSDC usdc;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(ARC_USDC);
        coord = new ArcDrawCoordinator(ARC_USDC);
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A - coord.MIN_ROUND_DELAY()));
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(coord), type(uint256).max);
    }

    function _run(uint256 seed, uint256 n, bool fresh) internal {
        SimDivergentConsumer evil = new SimDivergentConsumer(coord);
        uint256[] memory ids = new uint256[](n);
        uint32[] memory cbs = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 3 == 0) {
                vm.prank(alice);
                (ids[i],) = coord.requestRandomness(0, uint96(1 + r % 1e6));
            } else {
                // high bits pick the budget so it is independent of the branch above
                cbs[i] = uint32((r >> 128) % (coord.MAX_CALLBACK_GAS_LIMIT() + 1));
                (ids[i],) = evil.request(cbs[i], 0);
            }
        }
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        if (!fresh) coord.verifyRound(Quicknet.ROUND_A, Quicknet.SIG_A);

        bytes memory data = abi.encodeCall(coord.fulfillBatch, (Quicknet.ROUND_A, Quicknet.SIG_A, ids));
        uint256 txGas = WorstCaseGas.batch(fresh, cbs);
        uint256 allowance = WorstCaseGas.executionAllowance(txGas, data);
        vm.txGasPrice(20 gwei);
        vm.prank(relayer);
        uint256 g0 = gasleft();
        (bool ok,) = address(coord).call{gas: allowance}(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "worst-case bound too low");
        assertLe(used, allowance);
        for (uint256 i; i < n; ++i) {
            assertEq(uint8(coord.getRequest(ids[i]).status), uint8(IArcDrawCoordinator.Status.Fulfilled));
        }
        console2.log("ids", n, "execution gas used", used);
        console2.log("bound (execution part)", allowance);
    }

    function test_bound_maxBatchAllMaxCallbacks_freshRound() public {
        SimDivergentConsumer evil = new SimDivergentConsumer(coord);
        uint256 n = 20; // relayer default RELAYER_MAX_BATCH
        uint256[] memory ids = new uint256[](n);
        uint32[] memory cbs = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            cbs[i] = coord.MAX_CALLBACK_GAS_LIMIT();
            (ids[i],) = evil.request(cbs[i], 0);
        }
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory data = abi.encodeCall(coord.fulfillBatch, (Quicknet.ROUND_A, Quicknet.SIG_A, ids));
        vm.txGasPrice(20 gwei);
        (bool ok,) =
            address(coord).call{gas: WorstCaseGas.executionAllowance(WorstCaseGas.batch(true, cbs), data)}(data);
        assertTrue(ok);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_bound_mixedBatch_freshRound(uint256 seed, uint8 n) public {
        _run(seed, bound(n, 1, 20), true);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_bound_mixedBatch_verifiedRound(uint256 seed, uint8 n) public {
        _run(seed, bound(n, 1, 20), false);
    }

    /// @notice Tightness check for the no-callback path (keeps cost-based bounty checks from being far too strict).
    function test_bound_noCallbacks_within40Percent() public {
        uint256 n = 5;
        uint256[] memory ids = new uint256[](n);
        uint32[] memory cbs = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            vm.prank(alice);
            (ids[i],) = coord.requestRandomness(0, 10_000);
        }
        vm.warp(coord.roundTimestamp(Quicknet.ROUND_A));
        bytes memory data = abi.encodeCall(coord.fulfillBatch, (Quicknet.ROUND_A, Quicknet.SIG_A, ids));
        uint256 allowance = WorstCaseGas.executionAllowance(WorstCaseGas.batch(true, cbs), data);
        uint256 g0 = gasleft();
        (bool ok,) = address(coord).call{gas: allowance}(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok);
        assertLe(allowance * 100, used * 140);
    }
}
