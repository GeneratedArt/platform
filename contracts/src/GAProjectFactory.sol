// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {GAProject} from "./GAProject.sol";

/// @title GAProjectFactory
/// @notice Deploys per-project ERC-721 contracts as EIP-1167 minimal
///         proxies of a single `GAProject` implementation. Cuts deploy
///         gas from ~3M to ~150k per project.
contract GAProjectFactory {
    error EmptyName();
    error EmptySymbol();
    error RoyaltyTooHigh();

    /// @notice Cap royalty at 10% to prevent typo-by-the-decimal-point
    ///         deploys; ERC-2981 itself has no upper bound.
    uint96 public constant MAX_ROYALTY_BPS = 1000;

    address public immutable implementation;

    event ProjectCreated(
        address indexed project,
        address indexed artist,
        string name,
        string symbol,
        uint96 royaltyBps,
        uint256 maxSupply
    );

    constructor(address impl) {
        require(impl != address(0), "impl=0");
        implementation = impl;
    }

    /// @notice Deploy a new GAProject clone owned by the caller.
    /// @return project Address of the newly deployed clone.
    function createProject(
        string calldata name,
        string calldata symbol,
        uint96 royaltyBps,
        uint256 maxSupply
    ) external returns (address project) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();

        project = Clones.clone(implementation);
        GAProject(project).initialize(name, symbol, msg.sender, royaltyBps, maxSupply);

        emit ProjectCreated(project, msg.sender, name, symbol, royaltyBps, maxSupply);
    }
}
