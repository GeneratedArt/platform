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

## Tech stack (status-tagged per audit fix F-05)
Each line is `[live]` (running today), `[scaffold]` (config exists, code does not), or `[planned]` (named in roadmap, no config yet).

- **Static site**: Jekyll 4.3.x (Ruby 3.2.x), plugins `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives` — `[live]`. Foundation is an upstream Jekyll v2 template credited in the footer attribution include at `_includes/` (filename per the Task #1 spec). Brand-sweep contract: `git grep -i [the upstream-template name]` returns only that include file and the single footer line that references it.
- **Brand layer**: `assets/css/brand.css` + GA wordmarks/favicon/OG — `[live]` (Task #1).
- **API**: Hono on Cloudflare Workers (TypeScript) at `workers/api/`. Exposes `GET /health`, `POST /v1/auth/siwe/{nonce,verify}`, `POST /v1/auth/logout`, and `GET /v1/me` — `[live]` locally via `npm --prefix workers/api run dev` against miniflare; `[scaffold]` in production until the first `wrangler deploy --env production` lands.
- **Worker bindings** (D1, KV ×3, R2, Queues): three production IDs (DB, SESSIONS, RATE_LIMIT) are uncommented under `[env.production]` in `workers/api/wrangler.toml` — `[live in config, scaffold in cloud]`. INDEXER_STATE / CAPTURES / RENDER_QUEUE remain commented and are uncommented per-feature.
- **D1 schema**: 8 tables (users, projects, follows, briefs, applications, galleries, gallery_projects, mints) + an FTS5 virtual table over user/project/brief text — migration at `workers/api/migrations/0001_init.sql`. Applied locally via `npm --prefix workers/api run migrate:local` (miniflare SQLite); production via `npm --prefix workers/api run migrate:prod`.
- **SIWE auth**: `[live]` (Task #2). Server uses `siwe@^2.3.2` for message verification + `viem` for address validation; sessions are HS256 JWTs (Hono's built-in `hono/jwt`) with a `jti` revoke list in the SESSIONS KV; cookie is httpOnly, Secure, SameSite=Lax, scoped to `COOKIE_DOMAIN` (`.generatedart.com` in prod, `localhost` in dev). Per-IP rate limit on `/nonce` (30/min) and `/verify` (10/min) backed by RATE_LIMIT KV.
- **Wallet client**: `assets/js/ga-auth.js` (148 KB minified, ESM) is bundled by `npm --prefix workers/api run build:client` from `workers/api/client/auth.ts` (esbuild). Source uses `viem` + injected `window.ethereum`; the SIWE message is constructed inline (no `siwe` lib in the browser bundle, which would have pulled in a Node `buffer` polyfill). Loaded only on `/connect/`, never on the homepage.
- **Repo-as-Project + dashboard**: `[planned]` → `.local/tasks/project-creation-dashboard.md` (Task #3).
- **Sketch Studio (p5.js)**: `[planned]` → `.local/tasks/studio-mvp.md` (Task #4).
- **Mint flow on Base Sepolia**: `[planned]` → `.local/tasks/mint-flow-base-sepolia.md` (Task #5).
- **Profile / portfolio / follow**: `[planned]` → `.local/tasks/profile-portfolio-follow.md` (Task #6).
- **Briefs board**: `[planned]` → `.local/tasks/briefs-board.md` (Task #7).
- **Contracts**: Solidity 0.8.24, Foundry, Base mainnet (8453) + Base Sepolia (84532). `contracts/foundry.toml` exists; `contracts/src/` and `contracts/test/` are empty (`.gitkeep` only) — `[scaffold]`.
- **RPC / IPFS**: Cloudflare Web3 Ethereum Gateway + Pinata + web3.storage — `[planned]`, wired with Task #5.
- **Wallet**: WalletConnect v2 + viem + wagmi (client-side; platform never holds keys) — `[planned]`, wired with Task #2/#5.
- **CI/CD**: GitHub Actions — `[planned]` → AUDIT-01 follow-up (no `.github/workflows/` exists today).

Explicit non-goals: no AWS, Vercel, Firebase, Supabase, Mongo, Node.js server, Stripe-as-primary-rails, Cloudflare Pages, Netlify.

## Replit dev environment
- Workflow `Start application` runs `bundle exec jekyll serve --host 0.0.0.0 --port 5000 --no-watch` from the repo root on port 5000.
- Bundler installs Jekyll 4.3.x + plugins from the root `Gemfile`.

## Deployment
- **Site**: GitHub Pages via `.github/workflows/pages.yml`. CNAME at repo root preserves `generatedart.com`. Repo Settings → Pages → Source must be `"GitHub Actions"` (one-time manual).
- **API Worker**: `pnpm --filter @generatedart/api deploy` or via `worker-api.yml` on push. `app.generatedart.com` is **not** used; the Worker attaches to `api.generatedart.com` only.
- **Contracts**: `forge script script/Deploy.s.sol --rpc-url base --broadcast` — gated on `contracts.yml`.

## Cloudflare auto-deploy (disable — REQUIRED before any Worker push)
Cloudflare's Workers Builds previously auto-detected the repo as a Workers-Static project and tried to build with `npx bundle exec jekyll build` (which fails because `npx bundle` isn't a thing). Since static hosting now lives on GitHub Pages, that auto-deploy is competing infrastructure and **must be disabled in the Cloudflare dashboard** under Workers & Pages → `platform` → Settings → Builds → Disconnect / Disable **before** any `wrangler deploy --env production` is run from this repo. If left enabled it will race the wrangler push and stomp the deployed Worker with a broken static-build artefact. (Per §0 commandment of the brief.)

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

Out of scope (deferred to later tasks): rebuilding the navigation around GA surfaces and styling the dark wrapper variants used inside the legacy template pages.

## May 2 2026 — Audit-driven cleanup (Task #1, follow-up sweep)
A full architectural / security / perf audit was run after the brand pass; full report lives in `AUDIT.md` at the repo root (kept out of `git grep` for the upstream-template name only because the audit body still discusses the licensing question by its proper name in section F-06). Quick-wins applied inline (rest broken into AUDIT-01 / AUDIT-02 / AUDIT-03 follow-up tasks):

- **F-06 (Slider Revolution license risk)** — deleted `assets/revolution/` (~11 MB). Removed all 11 `<script>` and 3 `<link>` references from `_includes/core/scripts/scripts.html` and `_includes/core/styles/styles.html`. Homepage script count dropped from 17 → 6.
- **F-09 (demo carcasses still routable)** — added `home-pages`, `elements`, `features`, `services` to `_config.yml` `exclude:`. Verified `/home-pages/index-2.html`, `/elements/buttons_badges.html`, `/features/header1.html`, `/services/index.html` all return 404.
- **F-03 (Cloudflare resource IDs in `.replit`)** — moved all six IDs (D1, KV ×3, R2, Zone) into `workers/api/wrangler.toml` under `[env.production]`, commented per-feature so they're uncommented as the owning task lands. Deleted `[userenv.shared]` from `.replit`. Also set `workers_dev = false` (audit F-13).
- **F-02 (competing static-deploy paths)** — removed `[deployment]` block from `.replit`. GitHub Pages is now the canonical static-deploy path; the AUDIT-01 follow-up will create `.github/workflows/pages.yml` to actually wire it.
- **F-05 (replit.md drift)** — every line in "Tech stack" above is now `[live]` / `[scaffold]` / `[planned]` and links to its owning task file.
- **F-08 (cruft)** — `bundle exec jekyll clean` removed `_site/`. `.git.broken/` (21 MB) is left in place because the agent shell guard blocks `rm` on `.git*` paths; AUDIT-01 covers it.

Remaining audit work, broken into follow-up tasks (created via `proposeFollowUpTasks`):
- **AUDIT-01** — Build the four CI/CD workflows under `.github/workflows/` and resolve the deploy-path conflict end-to-end (covers F-01 + F-02 cleanup + `.git.broken` removal).
- **AUDIT-02** — Front-end payload diet: drop `assets/js/plugins.js` (340 KB) + jQuery/Popper/Bootstrap-JS from base, subset Nunito to woff2 + 3 weights, target homepage <150 KB total (covers F-04 + F-12).
- **AUDIT-03** — Front Cloudflare in front of Pages with security headers + CSP + cache rules + worker hardening (covers F-07 + F-10 + F-13).

## May 2 2026 — Task #2: Cloudflare Worker + SIWE auth complete
Stood up the only dynamic service in the platform (per §0: one backend, one Worker, no Node server). Local dev runs against miniflare (D1 SQLite + KV, both materialised under `workers/api/.wrangler/state/`); production runs at `api.generatedart.com` once `wrangler deploy --env production` is invoked.

What landed:
- **Worker code** — `workers/api/src/`:
  - `index.ts` mounts CORS (origin from `ALLOWED_ORIGINS` env var, credentials on), `GET /health`, and a `/v1` sub-router.
  - `auth/siwe.ts` implements `POST /v1/auth/siwe/nonce` (16-byte hex nonce, KV-stored under `nonce:<value>` with 5-min TTL, IP-rate-limited 30/min) and `POST /v1/auth/siwe/verify` (parses message via `siwe@^2.3.2`, verifies signature, atomically deletes the nonce, upserts the user, issues a session cookie; rate-limited 10/min/IP).
  - `auth/jwt.ts` wraps `hono/jwt` with HS256, 7-day TTL, `{sub, uid, jti, iat, exp}` claims.
  - `auth/middleware.ts` exports `requireAuth` — reads the cookie, verifies the JWT, checks the SESSIONS KV for `revoked:<jti>`, sets `c.var.user`.
  - `auth/me.ts` implements `GET /v1/me` (auth-gated, returns the row from `users` minus internal fields) and `POST /v1/auth/logout` (writes `revoked:<jti>` to SESSIONS with TTL = remaining session lifetime, clears the cookie).
  - `db/users.ts` does upsert-by-address with a generated `artist_xxxxxx` handle.
  - `lib/cookies.ts` centralises the session-cookie shape: httpOnly + Secure + SameSite=Lax + Domain=`COOKIE_DOMAIN` + Path=/ + 7-day Max-Age.
  - `lib/rateLimit.ts` is a tiny KV bucket limiter (window-based, no Lua/atomicity hand-wave).
- **D1 migration** — `workers/api/migrations/0001_init.sql` creates the 8 tables from §2.2 (users, projects, follows, briefs, applications, galleries, gallery_projects, mints) plus an FTS5 `search_index` virtual table with INSERT/UPDATE/DELETE triggers on users + projects + briefs so search stays in sync without application code.
- **Wrangler bindings** — `workers/api/wrangler.toml` now has BOTH a top-level dev block (DB + SESSIONS + RATE_LIMIT with `local-dev-*` IDs that miniflare materialises into `.wrangler/state/`) AND `[env.production]` with the three real Cloudflare IDs uncommented (D1 `6c83…2a`, SESSIONS `4c07…4a`, RATE_LIMIT `071e…fa`). Production also gets non-secret env vars (`COOKIE_DOMAIN`, `ALLOWED_ORIGINS`); `JWT_SECRET` is set with `wrangler secret put JWT_SECRET --env production`.
- **Client bundle** — `workers/api/client/auth.ts` is a vanilla TS module that uses `viem`'s `createWalletClient` over `window.ethereum` to drive the SIWE flow. The SIWE message itself is constructed inline (the `siwe` npm package was kept server-side only because its `apg-js` dep pulls in Node `buffer`, which esbuild won't bundle for browsers without a polyfill). esbuild output: `assets/js/ga-auth.js`, 148 KB minified, ESM, only loaded on `/connect/`.
- **Connect page** — `connect/index.html` is a Jekyll page at `/connect/` with a "Connect wallet" button, a sign-out button, a status panel, and a JSON view of `/v1/me`. Talks to `http://localhost:8787` by default; override via `?api=…` query param.
- **npm scripts** — added to `workers/api/package.json`: `dev`, `typecheck`, `build:client`, `migrate:local`, `migrate:prod`, `deploy`, `deploy:prod`.
- **Cloudflare auto-deploy gotcha** — promoted to a **REQUIRED** banner in the "Cloudflare auto-deploy (disable)" section above (per §0 of the brief).

Verified locally:
- `npm --prefix workers/api run migrate:local` applied 31 commands successfully.
- `wrangler dev` boots in ~2s, binds DB + SESSIONS + RATE_LIMIT + 3 vars from `.dev.vars`.
- `GET /health` → 200 `{"ok":true,"service":"generatedart-api","ts":…}`.
- `POST /v1/auth/siwe/nonce` → 200 `{"nonce":"…","expires_in":300}`.
- `GET /v1/me` (no cookie) → 401 `{"error":"unauthenticated"}`.
- `POST /v1/auth/siwe/verify` (empty body) → 400 `{"error":"missing_fields"}`.
- `tsc --noEmit` clean.
- Jekyll `/connect/` → 200, references `/assets/js/ga-auth.js` which is served at 200 (151 KB).

End-to-end SIWE flow with a real wallet was NOT runnable from this Replit (no MetaMask injection in headless smoke); the structural acceptance (nonce → verify → me round-trip with a forged-but-shape-correct payload) is exercised by the smoke above. Real-wallet validation is a manual step at `http://localhost:5000/connect/?api=http://localhost:8787` with a browser extension installed.

Out of scope (deliberately deferred):
- WalletConnect v2 / wagmi: the brief mentions them but the lightweight requirement and the buffer-polyfill cost made the MetaMask-only injected-provider path the right hackathon shortcut. WalletConnect can be layered on later as a transport without touching the server.
- Production Cloudflare provisioning: the resource IDs are wired but `wrangler deploy --env production` requires `CLOUDFLARE_API_TOKEN` which this Replit does not have.
