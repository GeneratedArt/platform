// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GAProject} from "../src/GAProject.sol";
import {GAProjectFactory} from "../src/GAProjectFactory.sol";

/// @notice Deploy the GAProject implementation + GAProjectFactory.
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url base_sepolia \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast --verify
contract Deploy is Script {
    function run() external returns (address impl, address factory) {
        vm.startBroadcast();
        impl = address(new GAProject());
        factory = address(new GAProjectFactory(impl));
        vm.stopBroadcast();

        console.log("GAProject implementation:", impl);
        console.log("GAProjectFactory:", factory);
    }
}
