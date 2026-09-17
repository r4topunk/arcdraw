// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ArcDrawCoordinator} from "../src/ArcDrawCoordinator.sol";
import {IArcDrawCoordinator} from "../src/interfaces/IArcDrawCoordinator.sol";
import {FairAllocation} from "../src/demo/FairAllocation.sol";

/// @notice Deterministic CREATE2 deployment of ArcDrawCoordinator and FairAllocation through the canonical
///         deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C (present on Arc mainnet and testnet).
///         Same salt + same bytecode => same addresses on every chain. Already-deployed contracts are skipped.
///
/// The signer is never read from this file. Use an encrypted Foundry keystore:
///   forge script script/Deploy.s.sol --rpc-url arc_mainnet --account $FOUNDRY_ACCOUNT --broadcast
/// Then record addresses: node script/write-deployment.mjs --chain 5042
///
/// Env (optional): ARCDRAW_SALT (bytes32), ARCDRAW_USDC (address; required on chains other than Arc).
contract DeployScript is Script {
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 public constant DEFAULT_SALT = keccak256("arcdraw.v1");

    error UnsupportedChain(uint256 chainId);
    error MissingCreate2Deployer();
    error DeploymentFailed(string name);

    function run() external returns (address coordinator, address fairAllocation) {
        bytes32 salt = vm.envOr("ARCDRAW_SALT", DEFAULT_SALT);
        address usdc = usdcFor(block.chainid);
        if (CREATE2_DEPLOYER.code.length == 0) revert MissingCreate2Deployer();

        vm.startBroadcast();
        coordinator = _deploy("ArcDrawCoordinator", salt, coordinatorInitCode(usdc));
        fairAllocation = _deploy("FairAllocation", salt, fairAllocationInitCode(coordinator));
        vm.stopBroadcast();

        if (address(FairAllocation(fairAllocation).coordinator()) != coordinator) revert DeploymentFailed("wiring");
        if (IArcDrawCoordinator(coordinator).USDC() != usdc) revert DeploymentFailed("usdc");

        console2.log("chainId          ", block.chainid);
        console2.log("USDC             ", usdc);
        console2.log("ArcDrawCoordinator", coordinator);
        console2.log("FairAllocation    ", fairAllocation);
    }

    function usdcFor(uint256 chainId) public view returns (address) {
        address fromEnv = vm.envOr("ARCDRAW_USDC", address(0));
        if (fromEnv != address(0)) return fromEnv;
        if (chainId == 5042 || chainId == 5042002) return ARC_USDC;
        revert UnsupportedChain(chainId);
    }

    function coordinatorInitCode(address usdc) public pure returns (bytes memory) {
        return abi.encodePacked(type(ArcDrawCoordinator).creationCode, abi.encode(usdc));
    }

    function fairAllocationInitCode(address coordinator) public pure returns (bytes memory) {
        return abi.encodePacked(type(FairAllocation).creationCode, abi.encode(coordinator));
    }

    function predict(bytes32 salt, bytes memory initCode) public pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initCode)))))
        );
    }

    function _deploy(string memory name, bytes32 salt, bytes memory initCode) internal returns (address addr) {
        addr = predict(salt, initCode);
        if (addr.code.length > 0) {
            console2.log("already deployed, skipping:", name);
            return addr;
        }
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        // casting to bytes20 is safe because ret.length is checked to be 20 first
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!ok || ret.length != 20 || address(bytes20(ret)) != addr || addr.code.length == 0) {
            revert DeploymentFailed(name);
        }
    }
}
