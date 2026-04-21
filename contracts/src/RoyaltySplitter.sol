// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title RoyaltySplitter
 * @notice Splits primary + secondary revenue: 85% artist, 10% platform multisig,
 *         5% gallery (if exhibitedAt != address(0)). When no gallery, the 5%
 *         flows to the platform.
 */
contract RoyaltySplitter {
    uint256 public constant ARTIST_BPS   = 8500;
    uint256 public constant PLATFORM_BPS = 1000;
    uint256 public constant GALLERY_BPS  = 500;
    uint256 public constant DENOM        = 10_000;

    address public immutable artist;
    address public immutable platform;
    address public exhibitedAt; // settable once by platform; 0 == no gallery

    address public immutable governor; // platform multisig

    event ExhibitedAtSet(address indexed gallery);
    event Released(address indexed to, uint256 amount);

    error NotGovernor();
    error AlreadySet();
    error NothingToRelease();
    error TransferFailed();

    constructor(address _artist, address _platform, address _governor) {
        artist = _artist;
        platform = _platform;
        governor = _governor;
    }

    function setExhibitedAt(address gallery) external {
        if (msg.sender != governor) revert NotGovernor();
        if (exhibitedAt != address(0)) revert AlreadySet();
        exhibitedAt = gallery;
        emit ExhibitedAtSet(gallery);
    }

    receive() external payable {}

    function release() external {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToRelease();

        uint256 toArtist   = (bal * ARTIST_BPS)   / DENOM;
        uint256 toGallery  = (bal * GALLERY_BPS)  / DENOM;
        address galleryAddr = exhibitedAt;
        uint256 toPlatform = bal - toArtist - (galleryAddr == address(0) ? 0 : toGallery);

        _send(artist, toArtist);
        if (galleryAddr != address(0)) _send(galleryAddr, toGallery);
        _send(platform, toPlatform);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Released(to, amount);
    }
}
