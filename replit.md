# GeneratedArt — Platform Monorepo

## Overview
Community-run generative art platform and NFT marketplace for code-based generative art (p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge through the Geneva gallery.

## Repository
- **Canonical remote**: `https://github.com/GeneratedArt/platform.git` (this is the live monorepo)
- **Archived predecessor**: `https://github.com/GeneratedArt/website` — held only the Jekyll site under the old layout; superseded April 2026
- Migration April 23 2026 was a `fast-export | fast-import` rebuild (resolves a corrupt-pack issue in the old object DB and drops 26 MB of stale root-level `_site/` build output that pre-dated the `site/` move). 63 commits preserved, message/author/date intact, but commit shas differ from any pre-migration local clone — anyone with an older checkout should re-clone.
- Auth: pushes from this Replit use a fine-grained PAT in `GITHUB_PAT` (Contents: R/W, Workflows: R/W, Metadata: R/O), scoped to `GeneratedArt/platform` only. Token never lands on disk or in the remote URL — supplied to git via an inline credential helper.

## Monorepo layout
```
platform/
├── site/         Jekyll public site → GitHub Pages (generatedart.com)
├── app/          Astro islands app  → Cloudflare Workers (app.generatedart.com)
├── templates/
│   └── art-template/  Repo seed for every art-<slug> project (force-pushed to GeneratedArt/art-template)
├── workers/
│   ├── api/         REST API (Hono) — D1 + KV + R2 + Queues
│   ├── github-bot/  GitHub App webhook handler
│   ├── indexer/     Cron-triggered chain indexer (Base)
│   ├── renderer/    IPFS proxy + token-hash injection (renderer.generatedart.com/render?cid=&hash=&res=)
│   ├── capture/     Browser Rendering queue consumer — drains render-jobs, screenshots 2048² PNG → R2
│   └── shared/      Drizzle schemas + zod types
├── contracts/    Foundry — GenArtFactory, GenArtProject, RoyaltySplitter
├── .github/workflows/  build-site, deploy-workers, test-contracts, validate-bundle
├── docs/         architecture.md, self-hosting.md
├── scripts/      bootstrap.sh, seed.sql
├── package.json  pnpm workspaces
└── pnpm-workspace.yaml
```

## Tech stack (non-negotiable per spec)
- **Static site**: Jekyll 3.8.7 (Ruby 3.2.2, bundler) → GitHub Pages
- **Dynamic app**: Astro + Preact islands → Cloudflare Workers (`@astrojs/cloudflare` adapter, `output: "server"`)
- **API**: Hono on Cloudflare Workers (TypeScript)
- **Relational**: Cloudflare D1 (SQLite, Drizzle types)
- **KV**: Sessions, rate-limit, indexer state
- **R2**: Captures, thumbnails, signed uploads
- **Queues**: render-jobs, ipfs-pin-jobs
- **RPC**: Cloudflare Web3 Ethereum Gateway (Base)
- **IPFS**: Cloudflare gateway (read), Pinata + web3.storage (pin failover)
- **Code registry**: GitHub org `GeneratedArt`, one repo per project (`art-<slug>`)
- **Wallet**: WalletConnect v2 + viem + wagmi (client-side; platform never holds keys)
- **Contracts**: Solidity 0.8.24, Foundry, Base mainnet (8453) + Base Sepolia
- **CI/CD**: GitHub Actions

Explicit non-goals: no AWS, no Vercel, no Firebase, no Supabase, no Mongo, no Node.js server, no Stripe-as-primary-rails.

## Replit dev environment
- The workflow `Start application` runs only the Jekyll site on port 5000 for the Replit preview.
- For full local dev (Jekyll + Astro + API Worker + Renderer), use `pnpm dev` in a shell — that runs four servers concurrently (Jekyll :4000, Astro :4321, API :8787, Renderer :8788). Replit can only preview one port at a time.
- Secrets live in Replit's secret manager, mirrored to `workers/api/.dev.vars` for Wrangler. `.dev.vars` is gitignored; `.dev.vars.example` is the template.

## Workflow command
```
cd site && bundle exec jekyll serve --host 0.0.0.0 --port 5000 --no-watch
```

## Ruby 3.x compatibility
Jekyll 3.8.x predates Ruby 3.x stdlib changes. `site/Gemfile` adds:
- `rexml` — kramdown dependency, removed from Ruby 3 stdlib
- `webrick` — Jekyll serve dependency, removed from Ruby 3 stdlib
- `--no-watch` flag avoids a `pathutil` bug in `Jekyll::Utils::Platforms.bash_on_windows?`

## Deployment
- Site: GitHub Pages via `.github/workflows/pages.yml` (configure-pages → jekyll build `site/` → upload-pages-artifact → deploy-pages). CNAME preserved at `site/CNAME`. Repo Settings → Pages → Source must be set to "GitHub Actions" (not "Deploy from a branch").
- App: Cloudflare Workers via `@astrojs/cloudflare` adapter; `pnpm --filter @generatedart/app deploy` ships it. Custom route `app.generatedart.com/*` declared in `app/wrangler.toml`.
- Workers: `pnpm --filter @generatedart/<name> deploy` (wrangler).
- Contracts: `forge script script/Deploy.s.sol --rpc-url base --broadcast`.
- All deploys are gated on GitHub Actions; see `.github/workflows/`.

## MVP ship order (from spec section 17)
1. Monorepo + Jekyll site skeleton on Pages preview ← **scaffolding done**
2. GitHub OAuth Worker + `/me` ← **implemented** (full route surface for spec §6: `/auth/github/callback`, `/auth/siwe/verify`, `/me`, `/artists/*`, `/projects/*`, `/editions/*`, `/owners/*`, `/galleries/*`, `/editions/:id/request-physical`, with audit-log writes on mutations and KV-token-bucket rate limiting at 60/min session, 10/min anon)
3. Artist application flow end-to-end ← **implemented** (§8.1 — `POST /applications` opens an issue in `GeneratedArt/applications` and mirrors the row in D1's new `applications` table; `POST /webhooks/github` verifies the HMAC signature and on `approved`/`rejected` label flips status, promotes the user's role to `artist`, and seeds an `artists` row. UI: `/apply` and `/auth/github/callback/` Jekyll pages backed by `assets/js/{ga-auth,apply}.js`. `GET /me/projects` exposes the artist's own drafts; public `GET /projects` only ever returns live/sold_out so drafts can't be scraped.)
4. Project Studio ← **implemented** (§8.2 — `/studio` Jekyll dashboard at `assets/js/studio.js` lists the artist's projects and creates new ones via `POST /projects`, which generates a repo from the org template, writes CODEOWNERS, and protects `main` requiring the `validate-bundle` check + 1 code-owner review. §8.3 immutability — `POST /projects/:slug/publish` calls `protectReleaseTag()` to lock the tag once the bundle is pinned.)
5. Bundle validator Action (deterministic render check) ← **implemented** in `templates/art-template/.github/workflows/validate-bundle.yml`: 3 MB zip cap, required-files, forbidden-pattern + remote-script + library-allowlist checks, plus a Playwright Chromium two-run pixel-diff with `file://`-only network policy
6. Contracts on Base Sepolia + Foundry tests ← contracts + tests scaffolded
7. Renderer subdomain serving demo bundle ← **implemented** (`workers/renderer`: fetches `ipfs://<cid>/index.html`, injects `<script>` exposing `$ga.{hash,width,height,rand,features,preview}` with Mulberry32 seeded from the hash, serves with strict CSP + `X-Frame-Options: SAMEORIGIN` so consumers must use `<iframe sandbox="allow-scripts allow-pointer-lock">`; `res=WxH` clamped to 64–4096). Capture pipeline in `workers/capture` consumes the `render-jobs` queue via Cloudflare Browser Rendering / Puppeteer, waits for the `ga:preview` postMessage, screenshots PNG, writes to R2 at `captures/<contract>/<tokenId>.png` (or `previews/<slug>/<hash>.png` for ad-hoc), and patches `editions.preview_r2_key`
8. Astro app (§11) at `app/` ← **implemented** — full studio, mint, dashboard, admin, exhibitions surface backed by the existing Worker API:
    - `app/src/layouts/AppLayout.astro` + `styles/app.css` — shared dark-default design system mirroring the Jekyll site (Inter + Fraunces, GA red brand, sticky nav, footer)
    - `app/src/lib/{api,session}.ts` — fetch wrapper using `Authorization: Bearer <localStorage['ga.session_token']>`, in-memory `loadMe()` cache, GitHub OAuth redirect with `sessionStorage` state validation
    - Preact islands: `SignInIsland.tsx` (nav account widget, hydrated `client:load`), `MintIsland.tsx` (raw EIP-1193 — `eth_requestAccounts`, `wallet_switchEthereumChain` to Base 8453 / Base Sepolia 84532, `mint(address)` via selector `0x6a627842` + `eth_sendTransaction`, basescan deep-link, preview-hash roller wired to the renderer iframe)
    - Pages: `/`, `/studio`, `/studio/new` (auto-slug wizard), `/mint/[slug]`, `/collect/[address]`, `/dashboard` (collector + optional SIWE wallet link), `/admin` (curator-only — pending applications + projects-in-review with Approve action), `/exhibitions/new` (gallery steward form, resolves slugs → ids client-side), `/auth/callback` (OAuth code → session token)
    - `~` Vite alias mapped to `./src` in both `astro.config.mjs` and `tsconfig.json` so inline `<script type="module">` blocks can `import "~/lib/api.ts"` cleanly
    - Worker contracts the Astro app calls have been verified end-to-end: `POST /projects` uses `price_eth` + `description`; `GET /projects/:slug/mint-params` returns `{contract, price_wei, chain_id, remaining}`; `POST /galleries/:slug/exhibitions` takes integer `starts_at`/`ends_at` + `project_ids[]`. Two small Worker tweaks shipped alongside: `GET /projects?status=...` now allows curators/stewards to query any status (so admin can render its review queue) and the public list returns `github_repo` + `bundle_cid`; `GET /owners/:address/editions` joins through to the project for `bundle_cid` + `contract_address` so the collect page can render live previews without N+1 fetches
    - Build verified clean (`npx astro build` — 9 routes, 14 client modules, ~30 KB JS pre-gzip). Dev port 4321 (Cloudflare adapter, `output: "server"`); Replit only previews one port at a time so Jekyll on 5000 stays the default workflow.
9. Indexer Worker backfilling editions ← worker scaffolded
10. Public Jekyll site ← **implemented** — new editorial layer lives alongside the legacy agency template:
    - `site/_layouts/{genart,artist,project,gallery}.html` — clean layouts with Inter + Fraunces, dark default + light toggle (theme preference set before paint, no flash)
    - `site/assets/css/genart.css` — design tokens, grid, countdown, filter bar, editorial article type. v2 visual layer (fxhash + highlight.xyz inspired, GA red as the brand color): `--ga-red` token promoted to `--accent`; new components `.ga-ticker` (marquee activity feed above nav), `.ga-tabs` (underlined fxhash-style tabs with red count pills), `.ga-progress` (red mint-progress bar), `.ga-feature` (highlight.xyz hero with media + mint pane), `.ga-mint` (project-page mint card), `.ga-card__overlay` (hover overlay on tiles), `.ga-dot` (pulsing live indicator). Red CTAs in nav + on `Mint` buttons. `::selection` and `:focus-visible` use red.
    - Pages: `/` (hero + featured-drop highlight pane + featured artists + latest-sales table), `/artists`, `/projects` (fxhash tabs: all/live/upcoming/past), `/galleries`, `/manifesto`, `/docs`, `/blog`. Activity ticker (`_includes/genart-ticker.html`) renders from `site.data.latest.activity` with a static fallback so the bar is never empty.
    - Jekyll collections `artists`, `projects`, `galleries` permalinked at `/artists/:slug/`, `/projects/:slug/`, `/galleries/:slug/` — one markdown file per entity in `_artists/`, `_projects/`, `_galleries/`
    - Seed entries: `oona-keller` (artist), `field-notes` (project) and `geneva` (flagship gallery, with hours, directions, current exhibition, 32-unit dongle edition)
    - `scripts/sync-d1-to-jekyll.mjs` snapshots D1 → `_data/latest.json` (+ regenerates collection markdown) in CI using `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_D1_DATABASE_ID`; safe to re-run, skips gracefully when secrets are absent
11. Physical bridge + Telegram relay
12. Governance charter + curator console
13. Base mainnet launch (genesis drop)

Steps 5 and 6 are critical — bundle validation and contract tests are where silent bugs cost real money.

## Key references
- Full architecture: [`docs/architecture.md`](./docs/architecture.md)
- Self-hosting: [`docs/self-hosting.md`](./docs/self-hosting.md)
- Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
