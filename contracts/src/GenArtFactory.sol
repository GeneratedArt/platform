// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GenArtProject} from "./GenArtProject.sol";
import {RoyaltySplitter} from "./RoyaltySplitter.sol";

/**
 * @title GenArtFactory
 * @notice Deploys one GenArtProject + one RoyaltySplitter per approved project.
 *         Only callable by the steward multisig.
 */
contract GenArtFactory {
    address public steward; // multisig
    address public platform; // platform treasury (often == steward)

    event ProjectCreated(address indexed project, string slug, address indexed artist);
    event StewardChanged(address indexed prev, address indexed next);

    error NotSteward();

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    constructor(address _steward, address _platform) {
        steward = _steward;
        platform = _platform;
    }

    function setSteward(address next) external onlySteward {
        emit StewardChanged(steward, next);
        steward = next;
    }

    function createProject(
        string calldata name,
        string calldata symbol,
        string calldata slug,
        address artist,
        uint256 royaltyBps,
        uint256 editionSize,
        uint256 pricePerMint,
        string calldata bundleCID
    ) external onlySteward returns (address project, address splitter) {
        splitter = address(new RoyaltySplitter(artist, platform, steward));
        project = address(
            new GenArtProject(
                name,
                symbol,
                slug,
                artist,
                splitter,
                royaltyBps,
                editionSize,
                pricePerMint,
                bundleCID
            )
        );
        emit ProjectCreated(project, slug, artist);
    }
}
