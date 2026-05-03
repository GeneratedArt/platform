// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GAProject} from "../src/GAProject.sol";
import {GAProjectFactory} from "../src/GAProjectFactory.sol";

contract GAProjectTest is Test {
    GAProject implementation;
    GAProjectFactory factory;
    GAProject project;

    address artist = address(0xA11CE);
    address collector = address(0xB0B);

    string constant NAME = "Flow Fields";
    string constant SYMBOL = "FLOW";
    uint96 constant ROYALTY_BPS = 500;
    uint256 constant MAX_SUPPLY = 100;
    string constant CID = "bafybeih7m5frozen";

    function setUp() public {
        implementation = new GAProject();
        factory = new GAProjectFactory(address(implementation));
        vm.prank(artist);
        address clone = factory.createProject(NAME, SYMBOL, ROYALTY_BPS, MAX_SUPPLY);
        project = GAProject(clone);
    }

    function test_FactoryEmitsProjectCreated() public {
        vm.expectEmit(false, true, false, true);
        emit GAProjectFactory.ProjectCreated(address(0), artist, NAME, SYMBOL, ROYALTY_BPS, MAX_SUPPLY);
        vm.prank(artist);
        factory.createProject(NAME, SYMBOL, ROYALTY_BPS, MAX_SUPPLY);
    }

    function test_FactoryRejectsEmptyName() public {
        vm.expectRevert(GAProjectFactory.EmptyName.selector);
        factory.createProject("", SYMBOL, ROYALTY_BPS, MAX_SUPPLY);
    }

    function test_FactoryRejectsExcessiveRoyalty() public {
        vm.expectRevert(GAProjectFactory.RoyaltyTooHigh.selector);
        factory.createProject(NAME, SYMBOL, 1001, MAX_SUPPLY);
    }

    function test_InitializeOnlyOnce() public {
        vm.expectRevert();
        project.initialize(NAME, SYMBOL, artist, ROYALTY_BPS, MAX_SUPPLY);
    }

    function test_OwnerIsArtist() public view {
        assertEq(project.owner(), artist);
        assertEq(project.name(), NAME);
        assertEq(project.symbol(), SYMBOL);
        assertEq(project.maxSupply(), MAX_SUPPLY);
    }

    function test_SetBaseFrozenCIDOnceAndLocks() public {
        vm.prank(artist);
        project.setBaseFrozenCID(CID);
        assertEq(project.frozenCID(), CID);
        assertTrue(project.isCIDLocked());

        vm.prank(artist);
        vm.expectRevert(GAProject.CIDAlreadyLocked.selector);
        project.setBaseFrozenCID("bafybeih7m5other");
    }

    function test_SetBaseFrozenCID_OnlyOwner() public {
        vm.prank(collector);
        vm.expectRevert();
        project.setBaseFrozenCID(CID);
    }

    function test_MintRequiresLockedCID() public {
        vm.expectRevert(GAProject.CIDNotSet.selector);
        project.mint(bytes32(uint256(1)));
    }

    function test_MintRejectsEmptySeed() public {
        vm.prank(artist);
        project.setBaseFrozenCID(CID);
        vm.expectRevert(GAProject.EmptySeed.selector);
        project.mint(bytes32(0));
    }

    function test_MintHappyPath() public {
        vm.prank(artist);
        project.setBaseFrozenCID(CID);

        bytes32 seed = keccak256("collector-1");
        vm.prank(collector);
        uint256 tokenId = project.mint(seed);

        assertEq(tokenId, 1);
        assertEq(project.ownerOf(tokenId), collector);
        assertEq(project.seedOf(tokenId), seed);
        assertEq(project.totalMinted(), 1);
    }

    function test_TokenURI() public {
        vm.prank(artist);
        project.setBaseFrozenCID(CID);
        bytes32 seed = bytes32(uint256(0xdeadbeef));
        vm.prank(collector);
        uint256 tokenId = project.mint(seed);

        string memory uri = project.tokenURI(tokenId);
        assertEq(
            uri,
            "ipfs://bafybeih7m5frozen/?seed=0x00000000000000000000000000000000000000000000000000000000deadbeef"
        );
    }

    function test_RoyaltyInfo() public {
        vm.prank(artist);
        project.setBaseFrozenCID(CID);
        vm.prank(collector);
        project.mint(bytes32(uint256(1)));

        (address receiver, uint256 amount) = project.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
        assertEq(amount, 1 ether * ROYALTY_BPS / 10000);
    }

    function test_SupportsERC2981() public view {
        // ERC-2981 interface id = 0x2a55205a
        assertTrue(project.supportsInterface(0x2a55205a));
        // ERC-721 = 0x80ac58cd
        assertTrue(project.supportsInterface(0x80ac58cd));
    }

    function test_MintLimit() public {
        vm.prank(artist);
        address smallClone = factory.createProject(NAME, SYMBOL, ROYALTY_BPS, 2);
        GAProject small = GAProject(smallClone);
        vm.prank(artist);
        small.setBaseFrozenCID(CID);

        vm.startPrank(collector);
        small.mint(bytes32(uint256(1)));
        small.mint(bytes32(uint256(2)));
        vm.expectRevert(GAProject.MintLimitReached.selector);
        small.mint(bytes32(uint256(3)));
        vm.stopPrank();
    }

    function test_UnlimitedSupplyWhenMaxIsZero() public {
        vm.prank(artist);
        address openClone = factory.createProject(NAME, SYMBOL, ROYALTY_BPS, 0);
        GAProject open = GAProject(openClone);
        vm.prank(artist);
        open.setBaseFrozenCID(CID);

        vm.startPrank(collector);
        for (uint256 i = 1; i <= 5; i++) {
            open.mint(bytes32(i));
        }
        vm.stopPrank();
        assertEq(open.totalMinted(), 5);
    }
}
