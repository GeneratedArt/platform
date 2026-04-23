# GeneratedArt — Platform Monorepo

## Overview
Community-run generative art platform and NFT marketplace for code-based generative art (p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge through the Geneva gallery.

## Repository
- **Canonical remote**: `https://github.com/GeneratedArt/platform.git`
- Git auth from this Replit uses a fine-grained PAT in `GITHUB_PAT` (Contents R/W, Workflows R/W, Metadata R/O), scoped to `GeneratedArt/platform`. Token never lands on disk or in the remote URL.

## April 23 2026 — Hard reset to Snowflake foundation
The previous monorepo (custom Jekyll site under `site/`, Astro app under `app/`, full Worker route surface, Foundry suite) was wiped and replaced with the **Snowflake Jekyll v2 template at the repo root**. Reason: cumulative incompatibilities between the legacy GitHub Pages config, multiple competing GitHub Actions workflows, and the Cloudflare auto-deploy that was treating the repo as a Workers-Static project.

Architecture after the reset is deliberately minimal:
- **One** static-site deployment target: GitHub Pages
- **One** dynamic service: a single Cloudflare Worker at `workers/api/`
- **No** Astro app (the `app/` subdomain idea was dropped — adds complexity without giving us anything Jekyll can't)
- **No** Cloudflare Pages, no Netlify, no auto-detection-driven builds

Everything else (galleries, artists, application flow, mint UI, Worker route surface, Foundry contracts) will be layered back onto the Snowflake foundation incrementally.

## Layout
```
platform/
├── _config.yml, _layouts/, _includes/, _data/, _posts/, ...   Jekyll site (root)
│   _authors/, _portfolio/, _shop_items/                        Snowflake collections
│   assets/, blogs/, portfolios/, services/, shop/, ...         Snowflake template content
├── CNAME                                                       generatedart.com
├── index.html, 404.html, search.json
├── workers/
│   └── api/        Hono Worker — /health only (foundation)
├── contracts/      Foundry placeholder (foundry.toml + remappings)
└── .github/workflows/
    ├── pages.yml         Jekyll build + GitHub Pages deploy
    ├── worker-api.yml    Wrangler deploy → api.generatedart.com
    └── contracts.yml     forge build + test
```

## Tech stack
- **Static site**: Jekyll 4.3.x (Ruby 3.2.x), plugins: `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives`. Snowflake v2 template as foundation.
- **API**: Hono on Cloudflare Workers (TypeScript)
- **Relational**: Cloudflare D1 (SQLite, Drizzle types) — to be re-added
- **KV**: Sessions, rate-limit, indexer state — to be re-added
- **R2**: Captures, thumbnails, signed uploads — to be re-added
- **Queues**: render-jobs, ipfs-pin-jobs — to be re-added
- **RPC**: Cloudflare Web3 Ethereum Gateway (Base)
- **IPFS**: Cloudflare gateway (read), Pinata + web3.storage (pin failover)
- **Wallet**: WalletConnect v2 + viem + wagmi (client-side; platform never holds keys)
- **Contracts**: Solidity 0.8.24, Foundry, Base mainnet (8453) + Base Sepolia (84532)
- **CI/CD**: GitHub Actions

Explicit non-goals: no AWS, Vercel, Firebase, Supabase, Mongo, Node.js server, Stripe-as-primary-rails, Cloudflare Pages, Netlify.

## Replit dev environment
- Workflow `Start application` runs `bundle exec jekyll serve --host 0.0.0.0 --port 5000 --no-watch` from the repo root on port 5000.
- Bundler installs Jekyll 4.3.x + plugins from the root `Gemfile`.

## Deployment
- **Site**: GitHub Pages via `.github/workflows/pages.yml`. CNAME at repo root preserves `generatedart.com`. Repo Settings → Pages → Source must be `"GitHub Actions"` (one-time manual).
- **API Worker**: `pnpm --filter @generatedart/api deploy` or via `worker-api.yml` on push. `app.generatedart.com` is **not** used; the Worker attaches to `api.generatedart.com` only.
- **Contracts**: `forge script script/Deploy.s.sol --rpc-url base --broadcast` — gated on `contracts.yml`.

## Cloudflare auto-deploy (disable)
Cloudflare's Workers Builds previously auto-detected the repo as a Workers-Static project and tried to build with `npx bundle exec jekyll build` (which fails because `npx bundle` isn't a thing). Since static hosting now lives on GitHub Pages, that auto-deploy is competing infrastructure and should be **disabled in the Cloudflare dashboard** under Workers & Pages → `platform` → Settings → Builds → Disconnect / Disable.

## Roadmap (post-foundation)
The Snowflake template ships with placeholder content (Snowlake branding, Lorem-ipsum copy, stub portfolio entries, etc.). The first feature pass is the **branding pass**: replace title/email/copyright/logo with GeneratedArt assets, switch the site theme to the red color scheme, then layer back individual sections (Galleries, Artists, Apply, Studio, Mint, Dashboard, Admin) one at a time on top of the template's existing layouts.
