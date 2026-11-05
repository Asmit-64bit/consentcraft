// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Version-bound consent, escrowed collectibles, and one primary sale.
/// @dev Does not establish authorship or grant copyright. No admin or upgrade key.
contract ConsentCraft is ERC721, ReentrancyGuard {
    struct Project {
        address owner;
        uint256 version;
        bytes32 contentHash;
        bytes32 termsHash;
        bytes32 digest;
        string metadataURI;
        uint256 priceWei;
        uint256 tokenId;
        bool minted;
        bool sold;
    }
    struct Proposal {
        bytes32 contentHash;
        bytes32 termsHash;
        string metadataURI;
        address[] contributors;
        uint16[] shares;
        uint256 priceWei;
    }

    mapping(bytes32 => Project) private projects;
    mapping(bytes32 => address[]) private contributors;
    mapping(bytes32 => uint16[]) private shares;
    mapping(bytes32 => mapping(address => uint256)) public approvedVersion;
    mapping(uint256 => bytes32) public tokenProject;
    mapping(address => uint256) public pendingPayments;
    uint256 public nextTokenId = 1;
    uint256 public totalPendingPayments;

    event VersionProposed(bytes32 indexed projectId, address indexed owner, uint256 version, bytes32 digest, bytes32 contentHash, bytes32 termsHash, string metadataURI, uint256 priceWei);
    event ConsentChanged(bytes32 indexed projectId, address indexed contributor, uint256 version, bool approved);
    event ComicMinted(bytes32 indexed projectId, uint256 indexed tokenId, uint256 version);
    event ComicPurchased(bytes32 indexed projectId, uint256 indexed tokenId, address indexed buyer, uint256 priceWei);
    event ProceedsAllocated(bytes32 indexed projectId, address indexed contributor, uint256 amount);
    event ProceedsWithdrawn(address indexed contributor, address indexed recipient, uint256 amount);

    error NotOwner();
    error UnknownProject();
    error InvalidProposal();
    error FrozenRoster();
    error AlreadyMinted();
    error WrongVersion();
    error NotContributor();
    error MissingConsent();
    error NotForSale();
    error IncorrectPayment();
    error NothingToWithdraw();
    error InvalidRecipient();
    error TransferFailed();

    constructor() ERC721("ConsentCraft", "CRAFT") {}

    /// @dev Owner namespace prevents another wallet from claiming an app project ID.
    function projectKey(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    function proposeVersion(bytes32 salt, uint256 expectedVersion, Proposal calldata proposal) external returns (bytes32 key) {
        key = projectKey(msg.sender, salt);
        Project storage p = projects[key];
        if (p.minted) revert AlreadyMinted();
        if (p.version != expectedVersion) revert WrongVersion();
        uint256 length = proposal.contributors.length;
        if (length == 0 || length != proposal.shares.length || proposal.contentHash == bytes32(0) || proposal.termsHash == bytes32(0) || bytes(proposal.metadataURI).length == 0 || bytes(proposal.metadataURI).length > 2048 || proposal.priceWei == 0) revert InvalidProposal();
        uint256 total;
        bool includesOwner;
        for (uint256 i; i < length; ++i) {
            if (proposal.contributors[i] == address(0) || proposal.shares[i] == 0) revert InvalidProposal();
            for (uint256 j; j < i; ++j) if (proposal.contributors[j] == proposal.contributors[i]) revert InvalidProposal();
            total += proposal.shares[i];
            if (proposal.contributors[i] == msg.sender) includesOwner = true;
        }
        if (total != 10000 || !includesOwner) revert InvalidProposal();
        if (p.version > 0) {
            if (contributors[key].length != length) revert FrozenRoster();
            for (uint256 i; i < length; ++i) if (contributors[key][i] != proposal.contributors[i]) revert FrozenRoster();
        } else {
            p.owner = msg.sender;
            contributors[key] = proposal.contributors;
        }
        shares[key] = proposal.shares;
        p.version++;
        p.contentHash = proposal.contentHash;
        p.termsHash = proposal.termsHash;
        p.metadataURI = proposal.metadataURI;
        p.priceWei = proposal.priceWei;
        p.digest = keccak256(abi.encode(block.chainid, address(this), key, p.version, proposal));
        // Approval entries retain their old version and cannot authorize this one.
        emit VersionProposed(key, msg.sender, p.version, p.digest, p.contentHash, p.termsHash, p.metadataURI, p.priceWei);
    }

    function setApproval(bytes32 key, uint256 version, bytes32 digest, bool approved) external {
        Project storage p = projects[key];
        if (p.owner == address(0)) revert UnknownProject();
        if (p.minted) revert AlreadyMinted();
        if (version != p.version || digest != p.digest) revert WrongVersion();
        bool member;
        for (uint256 i; i < contributors[key].length; ++i) if (contributors[key][i] == msg.sender) member = true;
        if (!member) revert NotContributor();
        approvedVersion[key][msg.sender] = approved ? version : 0;
        emit ConsentChanged(key, msg.sender, version, approved);
    }

    function mintComic(bytes32 key, uint256 version, bytes32 digest) external nonReentrant returns (uint256 tokenId) {
        Project storage p = projects[key];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.minted) revert AlreadyMinted();
        if (version != p.version || digest != p.digest) revert WrongVersion();
        for (uint256 i; i < contributors[key].length; ++i) if (approvedVersion[key][contributors[key][i]] != version) revert MissingConsent();
        p.minted = true;
        tokenId = nextTokenId++;
        p.tokenId = tokenId;
        tokenProject[tokenId] = key;
        // Mint directly into this contract's escrow; no creator can transfer it early.
        _mint(address(this), tokenId);
        emit ComicMinted(key, tokenId, version);
    }

    function buyComic(uint256 tokenId) external payable nonReentrant {
        bytes32 key = tokenProject[tokenId];
        Project storage p = projects[key];
        if (!p.minted || p.sold || p.tokenId != tokenId) revert NotForSale();
        if (msg.value != p.priceWei) revert IncorrectPayment();
        p.sold = true;
        uint256 allocated;
        uint256 length = contributors[key].length;
        for (uint256 i; i < length; ++i) {
            // The last contributor receives the explicitly approved rounding remainder.
            uint256 amount = i == length - 1 ? msg.value - allocated : Math.mulDiv(msg.value, shares[key][i], 10000);
            allocated += amount;
            pendingPayments[contributors[key][i]] += amount;
            emit ProceedsAllocated(key, contributors[key][i], amount);
        }
        totalPendingPayments += msg.value;
        _safeTransfer(address(this), msg.sender, tokenId);
        emit ComicPurchased(key, tokenId, msg.sender, msg.value);
    }

    function withdraw(address payable recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = pendingPayments[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingPayments[msg.sender] = 0;
        totalPendingPayments -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ProceedsWithdrawn(msg.sender, recipient, amount);
    }

    function getProject(bytes32 key) external view returns (Project memory) { return projects[key]; }
    function getContributors(bytes32 key) external view returns (address[] memory, uint16[] memory) { return (contributors[key], shares[key]); }
    function getApprovals(bytes32 key) external view returns (bool[] memory approved) {
        approved = new bool[](contributors[key].length);
        for (uint256 i; i < approved.length; ++i) approved[i] = approvedVersion[key][contributors[key][i]] == projects[key].version;
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return projects[tokenProject[tokenId]].metadataURI;
    }
}
