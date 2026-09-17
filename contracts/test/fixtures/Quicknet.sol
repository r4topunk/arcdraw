// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Real drand quicknet beacons from
///         https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
///         (fetched once, never at test time).
library Quicknet {
    uint64 internal constant ROUND_A = 1000000;
    bytes internal constant SIG_A =
        hex"83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72";
    bytes32 internal constant RAND_A = 0xb22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3;

    uint64 internal constant ROUND_B = 1000001;
    bytes internal constant SIG_B =
        hex"a5bd91e5e2d8c0bf51bffdfad87eef34348fd9c0b2df2bee39db90bdef7e1399b1a77bb2fe98b24d84c0936a306c4218";

    uint64 internal constant ROUND_C = 1000002;
    bytes internal constant SIG_C =
        hex"a96e2a020098645aa4f912dcca317a67e98c39909fe1a037798fb503f04272b8153bab438c7e8d298593af1bdf29e5c5";
    bytes32 internal constant RAND_C = 0x018e0e0c9e0d7906762eca633fab3ec5e97ee4cb8949e4eb9ee589160b49263d;

    /// @dev SDK parity vector: keccak256(abi.encode(RAND_A, 5042, 0x...A4CD4A11, 1)).
    address internal constant VECTOR_COORDINATOR = 0x00000000000000000000000000000000A4Cd4A11;
    bytes32 internal constant VECTOR_DERIVED = 0x67c3610c49e54102c1d8426213165d1c3bad88236befe84d4b1c3d2478a302fa;
}
