# GeneratedArt — Architecture

## Layers

| Layer | Tech | Domain |
|------|------|--------|
| Public site | Jekyll → Cloudflare Pages | `generatedart.com` |
| Dynamic app | Astro islands → Cloudflare Pages | `app.generatedart.com` |
| API | Hono on Cloudflare Workers | `api.generatedart.com` |
| GitHub bot | Worker | `bot.generatedart.com` |
| Indexer | Cron Worker (every minute) | (no public route) |
| Renderer | Worker | `renderer.generatedart.com` |
| Relational | Cloudflare D1 (SQLite) | — |
| Sessions / rate-limit | Cloudflare KV | — |
| Object storage | Cloudflare R2 | — |
| Queues | Cloudflare Queues | render, ipfs-pin |
| RPC | Cloudflare Web3 Ethereum Gateway | Base mainnet + Sepolia |
| IPFS read | Cloudflare Web3 IPFS Gateway (DNSLink) | `ipfs.generatedart.com` |
| IPFS pin | Pinata + web3.storage (failover) | — |
| Code registry | GitHub org `GeneratedArt`, one repo per project (`art-<slug>`) | — |
| Wallet | WalletConnect v2 + viem + wagmi | client-side |
| Contracts | Solidity 0.8.24, Foundry, Base L2 | chain id 8453 |

## Source-of-truth rules

1. **Smart contracts** are the ledger. D1 is a cache/index.
2. **GitHub** is the source of truth for artist code. IPFS is the immutable copy. The Cloudflare gateway is read-only — never rely on it for persistence.
3. **The platform never holds keys.** Collectors sign mint transactions in their own wallets. The steward multisig signs only factory deploys and treasury distributions.

## Request shapes

### Mint flow
```
Wallet  →  app.generatedart.com/mint/:slug
            ↓ reads /projects/:slug/mint-params
            ↓ wagmi.writeContract(GenArtProject.mint, value=price)
Wallet  →  Base RPC (via WalletConnect)
            ↓ tx mined, Transfer + Minted events
Indexer Worker (cron, every minute)
            ↓ reads logs from Cloudflare ETH Gateway
            ↓ upserts editions row in D1
Renderer  ←  ipfs.generatedart.com (CID resolved)
Capture Worker  ←  RENDER_QUEUE message → puppeteer → R2
```

### Project release flow
```
Artist opens PR with label `ready-for-review` on art-<slug>
  → validate-bundle.yml runs (size, allowlist, determinism)
  → 2-of-5 curator review
GitHub Bot Worker receives `pull_request.merged`
  → tags v1.0.0
  → enqueues PIN_QUEUE (Pinata + web3.storage)
  → pin succeeds → calls API /projects/:slug/approve
  → Steward relayer signs factory.createProject(...)
  → ProjectCreated event → indexer flips status to 'live'
```

## Security boundaries

- Renderer subdomain serves untrusted HTML inside `<iframe sandbox="allow-scripts allow-pointer-lock">`. CSP restricts `default-src` to `self` + the IPFS gateway.
- GitHub App private key, Pinata JWT, steward relayer key live only in Worker Secrets.
- Foundry tests cover: hash determinism, supply cap, royalty math, factory access control, splitter math (with/without gallery), reentrancy on mint.

## What is intentionally not here (V1)

See section 21 of the spec: no on-platform secondary order book, no multi-chain, no on-chain bundle storage, no fiat on-ramp, no native mobile.
