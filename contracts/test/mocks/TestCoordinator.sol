// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ArcDrawCoordinator} from "../../src/ArcDrawCoordinator.sol";

/// @notice ArcDrawCoordinator with the BLS pairing replaced by a deterministic fake signature per round, so
///         tests can fulfill arbitrary rounds. Everything else (canonical encoding, caching, bounties,
///         callbacks) is the production code. Real-signature coverage lives in ArcDrawCoordinatorReal.t.sol.
contract TestCoordinator is ArcDrawCoordinator {
    constructor(address usdc) ArcDrawCoordinator(usdc) {}

    function _verifyBls(uint64 round, bytes calldata signature) internal pure override returns (bool) {
        return keccak256(signature) == keccak256(fakeSignature(round));
    }
}

/// @notice 48 bytes, compression flag set, x < p (top 5 bits of x are zero).
function fakeSignature(uint64 round) pure returns (bytes memory sig) {
    bytes32 h = keccak256(abi.encodePacked("arcdraw-fake-sig", round));
    bytes32 h2 = keccak256(abi.encodePacked(h));
    sig = abi.encodePacked(bytes1(0x80), bytes1(0x00), h, bytes14(h2));
}
