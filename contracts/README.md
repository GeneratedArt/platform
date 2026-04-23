# GeneratedArt — Contracts

Foundry project for the GeneratedArt smart-contract suite on Base L2 (chain 8453) and Base Sepolia (chain 84532).

Contracts are intentionally absent during the foundation phase. They will be added back in this order: `RoyaltySplitter` → `GenArtProject` (ERC-721 + EIP-2981) → `GenArtFactory`.

## Local

```bash
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std
forge build
forge test -vvv
```

## CI

`.github/workflows/contracts.yml` runs `forge build`, `forge test`, `forge fmt --check`, and a coverage summary on every push that touches `contracts/**`.
