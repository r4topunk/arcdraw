// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IArcDrawConsumer} from "./interfaces/IArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "./interfaces/IArcDrawCoordinator.sol";

/// @title ArcDrawConsumer
/// @notice Base contract for consumers. Inherit and implement `_fulfillRandomness`.
abstract contract ArcDrawConsumer is IArcDrawConsumer {
    IArcDrawCoordinator public immutable coordinator;

    error OnlyCoordinator(address caller);

    constructor(IArcDrawCoordinator coordinator_) {
        coordinator = coordinator_;
    }

    /// @inheritdoc IArcDrawConsumer
    function rawFulfillRandomness(uint256 requestId, bytes32 randomness) external {
        if (msg.sender != address(coordinator)) revert OnlyCoordinator(msg.sender);
        _fulfillRandomness(requestId, randomness);
    }

    /// @dev Keep this cheap and non-reverting; heavy work belongs in a separate permissionless call.
    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal virtual;
}
