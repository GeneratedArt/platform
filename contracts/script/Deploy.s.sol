// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {GenArtFactory} from "../src/GenArtFactory.sol";

contract Deploy is Script {
    function run() external {
        address steward  = vm.envAddress("STEWARD_ADDRESS");
        address platform = vm.envAddress("PLATFORM_ADDRESS");

        vm.startBroadcast();
        GenArtFactory factory = new GenArtFactory(steward, platform);
        vm.stopBroadcast();

        console2.log("Factory deployed to:", address(factory));
    }
}
