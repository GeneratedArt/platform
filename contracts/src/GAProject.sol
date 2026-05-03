// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC2981Upgradeable} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title GAProject
/// @notice Per-project ERC-721 deployed as an EIP-1167 minimal proxy by
///         GAProjectFactory. Each token wraps a `bytes32 seed` that the
///         frontend feeds into the artwork's PRNG; the metadata bundle
///         lives at a frozen IPFS CID set once and locked forever.
contract GAProject is Initializable, ERC721Upgradeable, ERC2981Upgradeable, OwnableUpgradeable {
    error CIDAlreadyLocked();
    error CIDNotSet();
    error MintLimitReached();
    error EmptySeed();

    event FrozenCIDLocked(string cid);
    event Minted(uint256 indexed tokenId, address indexed to, bytes32 seed);

    string private _frozenCID;
    bool private _cidLocked;
    uint256 private _nextId;
    uint256 public maxSupply;
    mapping(uint256 => bytes32) public seedOf;

    /// @dev Disable initializers on the implementation contract so it
    ///      can never be used directly — clones must call `initialize`.
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address artist_,
        uint96 royaltyBps_,
        uint256 maxSupply_
    ) external initializer {
        __ERC721_init(name_, symbol_);
        __ERC2981_init();
        __Ownable_init(artist_);
        _setDefaultRoyalty(artist_, royaltyBps_);
        maxSupply = maxSupply_;
    }

    /// @notice Set the frozen IPFS CID once. After this call the metadata
    ///         bundle is immutable for every token (current and future).
    function setBaseFrozenCID(string calldata cid) external onlyOwner {
        if (_cidLocked) revert CIDAlreadyLocked();
        _frozenCID = cid;
        _cidLocked = true;
        emit FrozenCIDLocked(cid);
    }

    function frozenCID() external view returns (string memory) {
        return _frozenCID;
    }

    function isCIDLocked() external view returns (bool) {
        return _cidLocked;
    }

    /// @notice Mint a new token bound to `seed`. Anyone can mint until
    ///         `maxSupply` is reached; the artist captures royalties via
    ///         ERC-2981 on every secondary sale.
    function mint(bytes32 seed) external returns (uint256 tokenId) {
        if (!_cidLocked) revert CIDNotSet();
        if (seed == bytes32(0)) revert EmptySeed();
        unchecked {
            tokenId = ++_nextId;
        }
        if (maxSupply != 0 && tokenId > maxSupply) revert MintLimitReached();
        seedOf[tokenId] = seed;
        _safeMint(msg.sender, tokenId);
        emit Minted(tokenId, msg.sender, seed);
    }

    /// @notice Total tokens minted so far.
    function totalMinted() external view returns (uint256) {
        return _nextId;
    }

    /// @inheritdoc ERC721Upgradeable
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!_cidLocked) revert CIDNotSet();
        // ipfs://{cid}/?seed={hex} — the frontend renderer inside the
        // bundle reads the seed from the URL and reproduces the artwork
        // deterministically.
        return string(
            abi.encodePacked(
                "ipfs://",
                _frozenCID,
                "/?seed=",
                Strings.toHexString(uint256(seedOf[tokenId]), 32)
            )
        );
    }

    /// @inheritdoc ERC721Upgradeable
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC2981Upgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
