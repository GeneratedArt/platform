# GeneratedArt — Platform Monorepo

## Overview
Community-run generative art platform and NFT marketplace for code-based generative art (p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge through the Geneva gallery.

## Repository
- **Canonical remote**: `https://github.com/GeneratedArt/platform.git`
- Git auth from this Replit uses a fine-grained PAT in `GITHUB_PAT` (Contents R/W, Workflows R/W, Metadata R/O), scoped to `GeneratedArt/platform`. Token never lands on disk or in the remote URL.

## April 23 2026 — Hard reset to GeneratedArt foundation
The previous monorepo (custom Jekyll site under `site/`, Astro app under `app/`, full Worker route surface, Foundry suite) was wiped and replaced with the **GeneratedArt Jekyll v2 template at the repo root**. Reason: cumulative incompatibilities between the legacy GitHub Pages config, multiple competing GitHub Actions workflows, and the Cloudflare auto-deploy that was treating the repo as a Workers-Static project.

Architecture after the reset is deliberately minimal:
- **One** static-site deployment target: GitHub Pages
- **One** dynamic service: a single Cloudflare Worker at `workers/api/`
- **No** Astro app (the `app/` subdomain idea was dropped — adds complexity without giving us anything Jekyll can't)
- **No** Cloudflare Pages, no Netlify, no auto-detection-driven builds

Everything else (galleries, artists, application flow, mint UI, Worker route surface, Foundry contracts) will be layered back onto the GeneratedArt foundation incrementally.

## Layout
```
platform/
├── _config.yml, _layouts/, _includes/, _data/, _posts/, ...   Jekyll site (root)
│   _authors/, _portfolio/, _shop_items/                        GeneratedArt collections
│   assets/, blogs/, portfolios/, services/, shop/, ...         GeneratedArt template content
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
- **Static site**: Jekyll 4.3.x (Ruby 3.2.x), plugins: `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives`. GeneratedArt v2 template as foundation.
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
The base Jekyll v2 template (see `_includes/[attribution].html`) ships with placeholder content (template branding, Lorem-ipsum copy, stub portfolio entries, etc.). The 24-hour hackathon scope is broken into 8 project tasks (#1–#8). Tasks #2–#8 layer back individual surfaces (Worker+SIWE, projects, studio, profile, mint, briefs, polish) one at a time on top of the template's existing layouts.

## May 2 2026 — Task #1: GA brand pass complete (v0.1.0-hackathon-brand)
Replaced every visible template branding reference with GA branding, except the single attribution line in `_includes/[attribution].html` (rendered at the bottom of every page via `_includes/layouts/footer/footer.html`). The grep acceptance is satisfied at the repo root excluding `.local/`, `.git/`, `attached_assets/`, `_site/`, `.jekyll-cache/`, and `node_modules/`.

What changed:
- **Brand tokens**: new `assets/css/brand.css` (NOT underscore-prefixed — Jekyll treats `_*.css` as partials and skips serving them) defines `--ga-paper #FAFAF7`, `--ga-ink #0A0A0A`, `--ga-accent #E63946`, `--ga-rule rgba(10,10,10,0.12)`, an 8pt spacing scale, and the type scale. Loaded LAST in `_includes/core/styles/styles.html` so it wins over the legacy `red.css` color scheme.
- **UI rules** (enforced globally with `!important`): no box shadows, no border-radius except on `.avatar` / `.rounded-circle` / `[class*="rounded-pill"]`, all cards/panels/widgets use 1px hairline borders with transparent fills, accent reserved for primary CTAs (`.btn-accent`) and active nav (`.nav-link.active`).
- **Wordmark**: `assets/img/ga-mark.svg` (dark on transparent) and `assets/img/ga-mark-light.svg` (light on transparent). Both wired in `_data/general_settings.yml` as the `black_logo_*` / `light_logo_*` entries — the existing `nav-1.html` `<img>` tags pick them up automatically.
- **Favicon + OG/Twitter**: `assets/img/ga-favicon.svg` (32×32, GA on ink). `assets/img/ga-og.svg` (1200×630 social card, GA hero on ink). `<meta name="theme-color" content="#0A0A0A">` injected in `styles.html`.
- **Homepage** (`index.html`): rewritten with the GA hero ("Code-based generative art, owned by the people who write it."), three repo→studio→mint columns, the four-line manifesto rules, and a six-card hackathon roadmap.
- **Footer**: `_includes/layouts/footer/footer.html` renders `{% include [the attribution include] %}` below the copyright. Copyright tightened to one line.
- **Sweep**: every other template-brand reference (HTML, MD, YAML, CSS, JS, Markdown posts, the icon-blob font dir, the glyph metadata inside `Jam.svg`, the `.fa-icon-*` class in vendor `font-awesome.css`, the `disqus_thread` shortname, and the README) was replaced with GA equivalents. The icon-blob font dir was deleted (unreferenced); `assets/type/type.css`'s `@font-face` for it was redirected to fall back on the Jam icon font.

Out of scope (deferred to later tasks): rebuilding the navigation around GA surfaces, removing the demo pages under `home-pages/`, `elements/`, `features/`, `services/`, `blogs/index-*.html` (they pass the grep test but still ship demo copy), and styling the dark wrapper variants used inside the demo pages.
