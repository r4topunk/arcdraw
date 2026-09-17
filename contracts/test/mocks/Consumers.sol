// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ArcDrawConsumer} from "../../src/ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "../../src/interfaces/IArcDrawCoordinator.sol";

interface IApprove {
    function approve(address, uint256) external returns (bool);
}

/// @notice Records the callback and the gas it received.
contract RecordingConsumer is ArcDrawConsumer {
    uint256 public calls;
    uint256 public lastRequestId;
    bytes32 public lastRandomness;
    uint256 public gasAtEntry;

    constructor(IArcDrawCoordinator c) ArcDrawConsumer(c) {}

    function request(uint32 gasLimit, uint96 bounty) external returns (uint256 id, uint64 round) {
        if (bounty > 0) IApprove(coordinator.USDC()).approve(address(coordinator), bounty);
        return coordinator.requestRandomness(gasLimit, bounty);
    }

    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal virtual override {
        gasAtEntry = gasleft();
        calls++;
        lastRequestId = requestId;
        lastRandomness = randomness;
    }
}

contract RevertingConsumer is RecordingConsumer {
    constructor(IArcDrawCoordinator c) RecordingConsumer(c) {}

    function _fulfillRandomness(uint256, bytes32) internal pure override {
        revert("nope");
    }
}

/// @notice Burns every unit of gas it receives.
contract GasGuzzlerConsumer is RecordingConsumer {
    constructor(IArcDrawCoordinator c) RecordingConsumer(c) {}

    function _fulfillRandomness(uint256, bytes32) internal pure override {
        while (true) {}
    }
}

/// @notice Returns a huge payload; the coordinator must not copy it.
contract ReturnDataBombConsumer is RecordingConsumer {
    constructor(IArcDrawCoordinator c) RecordingConsumer(c) {}

    function _fulfillRandomness(uint256, bytes32) internal pure override {
        assembly {
            revert(0, 100000)
        }
    }
}

/// @notice Tries to re-enter the coordinator from the callback.
contract ReentrantConsumer is RecordingConsumer {
    enum Mode {
        Fulfill,
        Batch,
        Refund,
        Request
    }

    Mode public mode;
    bytes public reentryRevert;
    bool public reentrySucceeded;
    bytes public sig;

    constructor(IArcDrawCoordinator c) RecordingConsumer(c) {}

    function setMode(Mode m, bytes calldata s) external {
        mode = m;
        sig = s;
    }

    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal override {
        super._fulfillRandomness(requestId, randomness);
        bytes memory data;
        if (mode == Mode.Fulfill) {
            data = abi.encodeCall(IArcDrawCoordinator.fulfill, (requestId + 1, sig));
        } else if (mode == Mode.Batch) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = requestId + 1;
            data = abi.encodeCall(IArcDrawCoordinator.fulfillBatch, (0, sig, ids));
        } else if (mode == Mode.Refund) {
            data = abi.encodeCall(IArcDrawCoordinator.refund, (requestId + 1));
        } else {
            data = abi.encodeCall(IArcDrawCoordinator.requestRandomness, (0, 0));
        }
        (bool ok, bytes memory ret) = address(coordinator).call(data);
        reentrySucceeded = ok;
        reentryRevert = ret;
    }
}

/// @notice Only records gasleft() at entry (one SSTORE), so it never runs out of gas above ~30k.
contract GasProbeConsumer is ArcDrawConsumer {
    uint256 public gasAtEntry;

    constructor(IArcDrawCoordinator c) ArcDrawConsumer(c) {}

    function request(uint32 gasLimit) external returns (uint256 id, uint64 round) {
        return coordinator.requestRandomness(gasLimit, 0);
    }

    function _fulfillRandomness(uint256, bytes32) internal override {
        gasAtEntry = gasleft();
    }
}

/// @notice Audit R1: cheap under eth_call / eth_estimateGas (tx.gasprice == 0), burns its whole callback budget in a
///         real transaction. A relayer that sizes the gas limit from the estimate sends a batch that reverts onchain.
contract SimDivergentConsumer is RecordingConsumer {
    constructor(IArcDrawCoordinator c) RecordingConsumer(c) {}

    function _fulfillRandomness(uint256, bytes32) internal view override {
        if (tx.gasprice == 0) return;
        while (true) {}
    }
}
