// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {GenArtFactory} from "../src/GenArtFactory.sol";
import {GenArtProject} from "../src/GenArtProject.sol";
import {RoyaltySplitter} from "../src/RoyaltySplitter.sol";

contract GenArtProjectTest is Test {
    GenArtFactory factory;
    GenArtProject project;
    RoyaltySplitter splitter;

    address steward  = address(0xA11CE);
    address platform = address(0xBEEF);
    address artist   = address(0xCAFE);
    address minter   = address(0xD00D);

    uint256 constant PRICE = 0.001 ether;
    uint256 constant SUPPLY = 10;

    function setUp() public {
        factory = new GenArtFactory(steward, platform);
        vm.prank(steward);
        (address p, address s) = factory.createProject(
            "Test", "TST", "test", artist, 750, SUPPLY, PRICE, "QmFakeCID"
        );
        project = GenArtProject(p);
        splitter = RoyaltySplitter(payable(s));
        vm.deal(minter, 100 ether);
    }

    function test_mintAssignsDeterministicHash() public {
        vm.prevrandao(bytes32(uint256(123)));
        vm.prank(minter);
        uint256 id = project.mint{value: PRICE}();
        bytes32 h = project.tokenHashes(id);
        assertTrue(h != bytes32(0));
        assertEq(project.ownerOf(id), minter);
    }

    function test_supplyCapEnforced() public {
        for (uint256 i = 0; i < SUPPLY; i++) {
            vm.prank(minter);
            project.mint{value: PRICE}();
        }
        vm.prank(minter);
        vm.expectRevert(GenArtProject.SoldOut.selector);
        project.mint{value: PRICE}();
    }

    function test_wrongPriceReverts() public {
        vm.prank(minter);
        vm.expectRevert(GenArtProject.WrongPrice.selector);
        project.mint{value: PRICE - 1}();
    }

    function test_royaltyInfoReturnsSplitter() public view {
        (address r, uint256 amt) = project.royaltyInfo(0, 1 ether);
        assertEq(r, address(splitter));
        assertEq(amt, (1 ether * 750) / 10_000);
    }

    function test_factoryAccessControl() public {
        vm.expectRevert(GenArtFactory.NotSteward.selector);
        factory.createProject("X", "X", "x", artist, 750, 1, PRICE, "Q");
    }

    function test_splitterMath_noGallery() public {
        vm.prank(minter);
        project.mint{value: PRICE}();

        uint256 sb = address(splitter).balance;
        assertEq(sb, PRICE);

        splitter.release();
        // 85% artist, 15% to platform when no gallery is set
        assertEq(artist.balance, (PRICE * 8500) / 10_000);
        assertEq(platform.balance, PRICE - (PRICE * 8500) / 10_000);
    }

    function test_splitterMath_withGallery() public {
        address gallery = address(0xC0FFEE);
        vm.prank(steward);
        splitter.setExhibitedAt(gallery);

        vm.prank(minter);
        project.mint{value: PRICE}();
        splitter.release();

        assertEq(artist.balance, (PRICE * 8500) / 10_000);
        assertEq(gallery.balance, (PRICE * 500) / 10_000);
        assertEq(platform.balance, (PRICE * 1000) / 10_000);
    }

    function test_tokenURIShape() public {
        vm.prank(minter);
        uint256 id = project.mint{value: PRICE}();
        string memory uri = project.tokenURI(id);
        assertEq(bytes(uri)[0], "i");
        assertEq(bytes(uri)[1], "p");
        assertEq(bytes(uri)[2], "f");
        assertEq(bytes(uri)[3], "s");
    }
}
