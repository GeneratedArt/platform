# GeneratedArt — Platform Monorepo

## Overview
Community-run generative art platform and NFT marketplace for code-based generative art (p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge through the Geneva gallery.

## Monorepo layout
```
platform/
├── site/         Jekyll public site → Cloudflare Pages (generatedart.com)
├── app/          Astro islands app  → Cloudflare Pages (app.generatedart.com)
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
- **Static site**: Jekyll 3.8.7 (Ruby 3.2.2, bundler) → Cloudflare Pages
- **Dynamic app**: Astro + Preact islands → Cloudflare Pages
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
- Site: Cloudflare Pages, build = `cd site && bundle exec jekyll build`, public dir = `site/_site` (current Replit deployment config still targets `_site` from old root layout — will need adjusting once we move to Cloudflare Pages).
- Workers: `pnpm --filter @generatedart/<name> deploy` (wrangler).
- Contracts: `forge script script/Deploy.s.sol --rpc-url base --broadcast`.
- All deploys are gated on GitHub Actions; see `.github/workflows/`.

## MVP ship order (from spec section 17)
1. Monorepo + Jekyll site skeleton on Pages preview ← **scaffolding done**
2. GitHub OAuth Worker + `/me` ← **implemented** (full route surface for spec §6: `/auth/github/callback`, `/auth/siwe/verify`, `/me`, `/artists/*`, `/projects/*`, `/editions/*`, `/owners/*`, `/galleries/*`, `/editions/:id/request-physical`, with audit-log writes on mutations and KV-token-bucket rate limiting at 60/min session, 10/min anon)
3. Artist application flow end-to-end ← **implemented** (POST /artists/apply opens issue in `GeneratedArt/applications`; github-bot listens for `approved` label and flips `artists.status` + promotes user role)
4. Project creation Worker (creates GitHub repo from template) ← **implemented** (POST /projects clones `GeneratedArt/art-template`, writes CODEOWNERS, applies branch protection requiring `validate-bundle` + 1 code-owner review on main)
5. Bundle validator Action (deterministic render check) ← **implemented** in `templates/art-template/.github/workflows/validate-bundle.yml`: 3 MB zip cap, required-files, forbidden-pattern + remote-script + library-allowlist checks, plus a Playwright Chromium two-run pixel-diff with `file://`-only network policy
6. Contracts on Base Sepolia + Foundry tests ← contracts + tests scaffolded
7. Renderer subdomain serving demo bundle ← **implemented** (`workers/renderer`: fetches `ipfs://<cid>/index.html`, injects `<script>` exposing `$ga.{hash,width,height,rand,features,preview}` with Mulberry32 seeded from the hash, serves with strict CSP + `X-Frame-Options: SAMEORIGIN` so consumers must use `<iframe sandbox="allow-scripts allow-pointer-lock">`; `res=WxH` clamped to 64–4096). Capture pipeline in `workers/capture` consumes the `render-jobs` queue via Cloudflare Browser Rendering / Puppeteer, waits for the `ga:preview` postMessage, screenshots PNG, writes to R2 at `captures/<contract>/<tokenId>.png` (or `previews/<slug>/<hash>.png` for ad-hoc), and patches `editions.preview_r2_key`
8. Mint page on Astro ← scaffolded at `/mint/:slug`
9. Indexer Worker backfilling editions ← worker scaffolded
10. Public Jekyll site ← **implemented** — new editorial layer lives alongside the legacy agency template:
    - `site/_layouts/{genart,artist,project,gallery}.html` — clean layouts with Inter + Fraunces, dark default + light toggle (theme preference set before paint, no flash)
    - `site/assets/css/genart.css` — design tokens, grid, countdown, filter bar, editorial article type
    - Pages: `/` (hero + next-drop countdown + featured artists + latest-sales table), `/artists`, `/projects` (filterable: all/live/upcoming/sold-out), `/galleries`, `/manifesto`, `/docs`, `/blog`
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
