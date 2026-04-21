// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {GenArtFactory} from "../src/GenArtFactory.sol";
import {GenArtProject} from "../src/GenArtProject.sol";
import {RoyaltySplitter} from "../src/RoyaltySplitter.sol";

/// @notice Attacker contract that tries to re-enter mint() through the
///         splitter `receive()` callback during fund forwarding.
contract MintReenterer {
    GenArtProject public project;
    uint256 public price;
    uint256 public attempts;

    constructor(GenArtProject p, uint256 _price) payable {
        project = p;
        price = _price;
    }

    function attack() external {
        project.mint{value: price}();
    }

    receive() external payable {
        // The splitter forwards funds here when this contract becomes the
        // royalty receiver. We try to re-enter mint().
        if (attempts < 3 && address(this).balance >= price) {
            attempts++;
            project.mint{value: price}();
        }
    }
}

/// @notice Splitter that funnels primary sale funds straight back to the
///         attacker so re-entry is even theoretically possible. The real
///         RoyaltySplitter splits across artist/platform/gallery, which means
///         only a fraction of the value would reach the attacker — but the
///         nonReentrant guard must hold even in the pathological case.
contract PassthroughSplitter {
    address payable public sink;

    constructor(address payable _sink) {
        sink = _sink;
    }

    receive() external payable {
        (bool ok, ) = sink.call{value: msg.value}("");
        require(ok, "sink_fail");
    }
}

contract ReentrancyTest is Test {
    GenArtProject project;
    MintReenterer attacker;

    uint256 constant PRICE = 0.001 ether;
    uint256 constant SUPPLY = 5;

    function setUp() public {
        // Deploy attacker first so its address is the royalty receiver.
        attacker = MintReenterer(payable(address(0))); // placeholder, replaced below

        // Two-step bootstrap: deploy a passthrough splitter that forwards to
        // the attacker, then deploy the project pointing at it, then deploy
        // the actual attacker pointing at the project.
        // We need the attacker before we can know the splitter's sink, so
        // deploy attacker with a temp project address then redeploy. To keep
        // it simple we use CREATE address prediction.
        address predictedAttacker = computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        PassthroughSplitter splitter = new PassthroughSplitter(payable(predictedAttacker));
        project = new GenArtProject(
            "Test", "TST", "test",
            address(0xCAFE),         // artist (unused for this test)
            address(splitter),
            750,
            SUPPLY,
            PRICE,
            "QmFakeCID"
        );
        attacker = new MintReenterer{value: PRICE * 4}(project, PRICE);
        require(address(attacker) == predictedAttacker, "address prediction failed");
    }

    function test_reentrancyOnMintReverts() public {
        vm.expectRevert(); // either Reentrancy() bubbled, or FORWARD_FAIL from outer call
        attacker.attack();
        // Whatever happened, at most one mint may have settled.
        assertLe(project.totalMinted(), 1);
    }
}
