// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract ChainPoemLineReceipts is ERC1155, Ownable {
    using ECDSA for bytes32;

    struct LineClaim {
        address recipient;
        uint256 tokenId;
        bytes32 claimKey;
        bytes32 poemHash;
        uint256 lineIndex;
        uint256 deadline;
    }

    address public signer;
    string private baseTokenUri;
    mapping(bytes32 => bool) public claimed;

    event SignerUpdated(address indexed signer);
    event BaseTokenUriUpdated(string baseTokenUri);
    event LineReceiptClaimed(
        address indexed recipient,
        uint256 indexed tokenId,
        bytes32 indexed claimKey,
        bytes32 poemHash,
        uint256 lineIndex
    );

    constructor(
        address initialOwner,
        address initialSigner,
        string memory initialBaseTokenUri
    ) ERC1155(initialBaseTokenUri) Ownable(initialOwner) {
        signer = initialSigner;
        baseTokenUri = initialBaseTokenUri;
        emit SignerUpdated(initialSigner);
        emit BaseTokenUriUpdated(initialBaseTokenUri);
    }

    function setSigner(address nextSigner) external onlyOwner {
        signer = nextSigner;
        emit SignerUpdated(nextSigner);
    }

    function setBaseTokenUri(string calldata nextBaseTokenUri) external onlyOwner {
        baseTokenUri = nextBaseTokenUri;
        emit BaseTokenUriUpdated(nextBaseTokenUri);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return string.concat(baseTokenUri, uintToString(tokenId), ".json");
    }

    function claimLine(LineClaim calldata claim, bytes calldata signature) external {
        require(msg.sender == claim.recipient, "recipient_only");
        require(block.timestamp <= claim.deadline, "claim_expired");
        require(!claimed[claim.claimKey], "claim_used");
        require(recoverSigner(claim, signature) == signer, "bad_signature");

        claimed[claim.claimKey] = true;
        _mint(claim.recipient, claim.tokenId, 1, "");
        emit LineReceiptClaimed(claim.recipient, claim.tokenId, claim.claimKey, claim.poemHash, claim.lineIndex);
    }

    function adminMintLine(address recipient, uint256 tokenId, bytes32 claimKey, bytes32 poemHash, uint256 lineIndex) external onlyOwner {
        require(!claimed[claimKey], "claim_used");
        claimed[claimKey] = true;
        _mint(recipient, tokenId, 1, "");
        emit LineReceiptClaimed(recipient, tokenId, claimKey, poemHash, lineIndex);
    }

    function recoverSigner(LineClaim calldata claim, bytes calldata signature) public view returns (address) {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                claim.recipient,
                claim.tokenId,
                claim.claimKey,
                claim.poemHash,
                claim.lineIndex,
                claim.deadline
            )
        );
        return MessageHashUtils.toEthSignedMessageHash(digest).recover(signature);
    }

    function uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
