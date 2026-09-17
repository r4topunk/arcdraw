// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../script/Deploy.s.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {FairAllocation} from "../src/demo/FairAllocation.sol";

contract DeployScriptTest is Test {
    DeployScript script;

    /// @dev Runtime code of the canonical CREATE2 deployer (Arachnid deterministic-deployment-proxy).
    bytes constant CREATE2_DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function setUp() public {
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, CREATE2_DEPLOYER_CODE);
        script = new DeployScript();
    }

    function test_deploy_arcMainnet_deterministicAndWired() public {
        vm.chainId(5042);
        (address c, address f) = script.run();
        bytes32 salt = script.DEFAULT_SALT();
        assertEq(c, script.predict(salt, script.coordinatorInitCode(0x3600000000000000000000000000000000000000)));
        assertEq(f, script.predict(salt, script.fairAllocationInitCode(c)));
        assertEq(ArcDrawCoordinator(c).USDC(), 0x3600000000000000000000000000000000000000);
        assertEq(address(FairAllocation(f).coordinator()), c);
        assertEq(address(FairAllocation(f).usdc()), 0x3600000000000000000000000000000000000000);

        // Idempotent: a second run skips and returns the same addresses.
        (address c2, address f2) = script.run();
        assertEq(c2, c);
        assertEq(f2, f);
    }

    function test_deploy_sameAddressesOnTestnet() public {
        vm.chainId(5042);
        bytes memory code = script.coordinatorInitCode(script.usdcFor(5042));
        assertEq(keccak256(code), keccak256(script.coordinatorInitCode(script.usdcFor(5042002))));
    }

    function test_deploy_revert_unsupportedChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployScript.UnsupportedChain.selector, uint256(1)));
        script.run();
    }

    function test_deploy_revert_missingCreate2Deployer() public {
        vm.chainId(5042);
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        vm.expectRevert(DeployScript.MissingCreate2Deployer.selector);
        script.run();
    }
}
