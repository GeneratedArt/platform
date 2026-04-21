# Deployments

One JSON file per chain ID. Updated by `script/Deploy.s.sol` after a successful
broadcast (and committed to git).

| File | Chain | Purpose |
|------|-------|---------|
| `8453.json` | Base mainnet | production |
| `84532.json` | Base Sepolia | staging / preview |

The indexer worker reads `contracts.GenArtFactory` from the file matching its
configured `CHAIN_ID` env var on cold start.
