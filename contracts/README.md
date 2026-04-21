# GeneratedArt — Smart Contracts

Foundry project. Solidity 0.8.24. Target: Base mainnet (chain id 8453) and Base Sepolia testnet.

## Contracts

- `GenArtFactory` — steward-only factory; deploys one `GenArtProject` + one `RoyaltySplitter` per approved project. Emits `ProjectCreated`.
- `GenArtProject` — per-project ERC-721 (minimal in-tree; production version should inherit ERC721A). Deterministic `tokenHashes` derived from `keccak256(projectSeed, tokenId, minter, block.prevrandao)`. EIP-2981 royalties pointing at the splitter.
- `RoyaltySplitter` — primary + secondary split: 85% artist / 10% platform / 5% gallery (when set). When no gallery is set, the gallery share flows to platform.

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install chiru-labs/ERC721A --no-commit
forge build
forge test -vv
```

## Deployments

Per-network addresses are committed under `deployments/<chain>.json` after each `Deploy.s.sol` broadcast:

```bash
STEWARD_ADDRESS=0x... PLATFORM_ADDRESS=0x... \
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```
