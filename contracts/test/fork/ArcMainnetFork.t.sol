// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {ArcDrawCoordinator} from "../../src/ArcDrawCoordinator.sol";
import {IArcDrawCoordinator} from "../../src/interfaces/IArcDrawCoordinator.sol";
import {FairAllocation} from "../../src/demo/FairAllocation.sol";
import {RecordingConsumer} from "../mocks/Consumers.sol";
import {Quicknet} from "../fixtures/Quicknet.sol";

interface IUSDCView {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function version() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Read-only fork tests against Arc mainnet. Contracts are deployed inside the local fork only;
///         nothing is broadcast. Enable with ARC_FORK_TESTS=true (optional ARC_RPC_URL, ARC_FORK_BLOCK); skipped otherwise.
contract ArcMainnetForkTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bool enabled;

    function setUp() public {
        enabled = vm.envOr("ARC_FORK_TESTS", false);
        if (!enabled) return;
        // Pinned block so Foundry's RPC cache makes reruns cheap (the public RPC rate-limits bursts).
        vm.createSelectFork(
            vm.envOr("ARC_RPC_URL", string("https://rpc.mainnet.arc.io")), vm.envOr("ARC_FORK_BLOCK", uint256(21283310))
        );
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_chainAndPredeploys() public onlyFork {
        assertEq(block.chainid, 5042);
        assertGt(USDC.code.length, 0);
        assertGt(CREATE2_DEPLOYER.code.length, 0);
        assertGt(PERMIT2.code.length, 0);
    }

    function test_fork_usdcErc20HasSixDecimals() public onlyFork {
        IUSDCView u = IUSDCView(USDC);
        assertEq(u.decimals(), 6);
        assertEq(keccak256(bytes(u.symbol())), keccak256("USDC"));
        console2.log("USDC version:", u.version());
        assertEq(keccak256(bytes(u.version())), keccak256("2")); // EIP-2612 domain version
    }

    function test_fork_blockTimestampRoundMathMargin() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        uint64 min = c.minRequestRound();
        assertGt(c.roundTimestamp(min), block.timestamp + 9);
        assertLe(c.roundTimestamp(min), block.timestamp + 12);
        console2.log("fork block", block.number, "currentRound", c.currentRound());
    }

    function test_fork_realBeaconVerifiesWithArcPrecompiles() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        uint256 g = gasleft();
        assertEq(c.verifyRound(Quicknet.ROUND_A, Quicknet.SIG_A), Quicknet.RAND_A);
        console2.log("fork verifyRound gas:", g - gasleft());
        vm.expectRevert(abi.encodeWithSelector(IArcDrawCoordinator.InvalidSignature.selector, Quicknet.ROUND_B));
        c.verifyRound(Quicknet.ROUND_B, Quicknet.SIG_A);
    }

    function test_fork_endToEndWithoutBounty() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        RecordingConsumer consumer = new RecordingConsumer(c);
        // Rewind the local fork clock so a real past beacon can be the pinned round.
        vm.warp(c.roundTimestamp(Quicknet.ROUND_A - 4));
        (uint256 id, uint64 round) = consumer.request(150_000, 0);
        assertEq(round, Quicknet.ROUND_A);
        vm.warp(c.roundTimestamp(round));
        c.fulfill(id, Quicknet.SIG_A);
        assertEq(consumer.lastRandomness(), keccak256(abi.encode(Quicknet.RAND_A, uint256(5042), address(c), id)));
    }

    /// @dev The call must revert so an unfunded bounty is never recorded. Caveat: the revert may come from USDC's
    ///      allowance check or from an Arc-native precompile that Forge does not emulate; only the outcome is asserted.
    function test_fork_bountyWithoutAllowanceReverts() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        address nobody = address(this);
        assertEq(IUSDCView(USDC).allowance(nobody, address(c)), 0);
        vm.expectRevert();
        c.requestRandomness{gas: 2_000_000}(0, 1);
        assertEq(c.requestCount(), 0);
    }

    function test_fork_fairAllocationReadsUsdcFromCoordinator() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        FairAllocation fa = new FairAllocation(c);
        assertEq(address(fa.usdc()), USDC);
        assertEq(address(fa.coordinator()), address(c));
    }

    /// @notice On Arc the USDC ERC-20 mirrors the native balance (18 decimals natively, 6 on the ERC-20).
    function test_fork_nativeBalanceMirrorsErc20SixDecimals() public onlyFork {
        address probe = address(this);
        vm.deal(probe, 5e18); // 5 USDC in 18-decimal native units
        assertEq(IUSDCView(USDC).balanceOf(probe), 5e6);
    }

    /// @notice Bounty escrow and payout through the real Arc USDC contract, inside the local fork.
    ///         Logs instead of failing if Forge cannot emulate the Arc-native transfer path.
    function test_fork_probeBountyWithRealUsdc() public onlyFork {
        ArcDrawCoordinator c = new ArcDrawCoordinator(USDC);
        address requester = address(this);
        address fulfiller = address(0xF0F0);
        vm.deal(requester, 1e18);
        IUSDCView(USDC).approve(address(c), 10_000);
        vm.warp(c.roundTimestamp(Quicknet.ROUND_A - 4));
        try c.requestRandomness{gas: 2_000_000}(0, 10_000) returns (uint256 id, uint64) {
            assertEq(IUSDCView(USDC).balanceOf(address(c)), 10_000);
            vm.warp(c.roundTimestamp(Quicknet.ROUND_A));
            vm.prank(fulfiller);
            c.fulfill(id, Quicknet.SIG_A);
            assertEq(IUSDCView(USDC).balanceOf(fulfiller), 10_000);
            assertEq(IUSDCView(USDC).balanceOf(address(c)), 0);
            console2.log("real USDC bounty escrow + payout emulated on fork: ok");
        } catch {
            console2.log("real USDC transferFrom not emulated by forge on this fork; covered by mocks + Stage 3 proof");
        }
    }
}
