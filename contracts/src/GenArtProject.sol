// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title GenArtProject
 * @notice Per-project ERC-721 with deterministic per-token hashes.
 *         Real implementation should inherit ERC721A + EIP-2981 from
 *         openzeppelin/erc721a once `forge install` is run. Until then this
 *         is a minimal-but-valid ERC-721-shaped contract usable in Foundry tests.
 */

interface IRoyalty {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount);
}

contract GenArtProject is IRoyalty {
    string public name;
    string public symbol;
    string public slug;

    address public immutable artist;
    address public immutable royaltyReceiver; // RoyaltySplitter
    uint256 public immutable royaltyBps;

    uint256 public immutable editionSize;
    uint256 public immutable pricePerMint;
    string  public bundleCID;
    bytes32 public immutable projectSeed;

    uint256 public totalMinted;

    mapping(uint256 => bytes32) public tokenHashes;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Minted(address indexed minter, uint256 indexed tokenId, bytes32 tokenHash);

    error SoldOut();
    error WrongPrice();
    error NotOwner();
    error InvalidRecipient();
    error Reentrancy();

    uint256 private _locked = 1;
    modifier nonReentrant() {
        if (_locked == 2) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        string memory _slug,
        address _artist,
        address _royaltyReceiver,
        uint256 _royaltyBps,
        uint256 _editionSize,
        uint256 _pricePerMint,
        string memory _bundleCID
    ) {
        name = _name;
        symbol = _symbol;
        slug = _slug;
        artist = _artist;
        royaltyReceiver = _royaltyReceiver;
        royaltyBps = _royaltyBps;
        editionSize = _editionSize;
        pricePerMint = _pricePerMint;
        bundleCID = _bundleCID;
        projectSeed = keccak256(abi.encode(_bundleCID, _artist, block.number));
    }

    function mint() external payable nonReentrant returns (uint256 tokenId) {
        if (totalMinted >= editionSize) revert SoldOut();
        if (msg.value != pricePerMint) revert WrongPrice();

        tokenId = totalMinted;
        unchecked { totalMinted = tokenId + 1; }

        bytes32 h = keccak256(abi.encode(projectSeed, tokenId, msg.sender, block.prevrandao));
        tokenHashes[tokenId] = h;

        ownerOf[tokenId] = msg.sender;
        unchecked { balanceOf[msg.sender] += 1; }

        emit Transfer(address(0), msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, h);

        // forward funds to splitter
        (bool ok, ) = royaltyReceiver.call{value: msg.value}("");
        require(ok, "FORWARD_FAIL");
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwner();
        if (from != msg.sender) revert NotOwner();
        if (to == address(0)) revert InvalidRecipient();
        ownerOf[tokenId] = to;
        unchecked {
            balanceOf[from] -= 1;
            balanceOf[to] += 1;
        }
        emit Transfer(from, to, tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(tokenId < totalMinted, "NONEXISTENT");
        return string(abi.encodePacked("ipfs://", bundleCID, "/", _toString(tokenId), ".json"));
    }

    // EIP-2981
    function royaltyInfo(uint256 /*tokenId*/, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        receiver = royaltyReceiver;
        royaltyAmount = (salePrice * royaltyBps) / 10_000;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return
            id == 0x01ffc9a7 || // ERC-165
            id == 0x80ac58cd || // ERC-721
            id == 0x5b5e139f || // ERC-721 metadata
            id == 0x2a55205a;   // EIP-2981
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        uint256 k = len;
        while (v != 0) { k--; b[k] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
