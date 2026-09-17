// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {BLS2} from "bls-solidity/libraries/BLS2.sol";

/// @notice Stage 1 feasibility spike: vendored randa-mu BLS2 verifies drand quicknet beacons
///         under the Osaka EVM (EIP-2537). Vectors from api.drand.sh (quicknet rounds 1000000/1000001).
contract QuicknetVerifyHarness {
    bytes constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    function pk() internal pure returns (BLS2.PointG2 memory) {
        return BLS2.PointG2(
            0x03cf0f2896adee7eb8b5f01fcad39122,
            0x12c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451,
            0x0d1fec758c921cc22b0e17e63aaf4bcb,
            0x5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a,
            0x01a714f2edb74119a2f2b0d5a7c75ba9,
            0x02d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b,
            0x0e5db2b6bfbb01c867749cadffca88b3,
            0x6c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273
        );
    }

    function verify(uint64 round, bytes calldata signature) external view returns (bool) {
        (bool pairingOk, bool callOk) = BLS2.verifySingle(
            BLS2.g1UnmarshalCompressed(signature),
            pk(),
            BLS2.hashToPoint(DST, abi.encodePacked(sha256(abi.encodePacked(round))))
        );
        return pairingOk && callOk;
    }
}

contract QuicknetVerifyTest is Test {
    QuicknetVerifyHarness h;

    bytes constant SIG_1000000 =
        hex"83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72";
    bytes32 constant RAND_1000000 = 0xb22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3;
    bytes constant SIG_1000001 =
        hex"a5bd91e5e2d8c0bf51bffdfad87eef34348fd9c0b2df2bee39db90bdef7e1399b1a77bb2fe98b24d84c0936a306c4218";

    function setUp() public {
        h = new QuicknetVerifyHarness();
    }

    function test_validBeaconVerifies() public view {
        uint256 g = gasleft();
        assertTrue(h.verify(1000000, SIG_1000000));
        console2.log("verify gas (compressed sig)", g - gasleft());
        assertTrue(h.verify(1000001, SIG_1000001));
    }

    function test_drandRandomnessIsSha256OfSignature() public pure {
        assertEq(sha256(SIG_1000000), RAND_1000000);
    }

    function test_wrongRoundFails() public view {
        assertFalse(h.verify(1000001, SIG_1000000));
    }

    function test_flippedSignBitFails() public view {
        bytes memory bad = SIG_1000000;
        bad[0] = bytes1(uint8(bad[0]) ^ 0x20);
        try h.verify(1000000, bad) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }
}
