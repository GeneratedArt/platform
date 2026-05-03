# GeneratedArt — Platform Monorepo

## Overview
GeneratedArt is a community-run generative art platform and NFT marketplace focusing on code-based generative art (p5.js / three.js / WebGL / GLSL). It aims to be a spiritual successor to platforms like fxhash and Art Blocks, incorporating a physical-digital bridge through the Geneva gallery. The project prioritizes a streamlined architecture with GitHub Pages for static content and a Cloudflare Worker for dynamic services.

## User Preferences
Not specified in the original document.

## System Architecture

### Core Design Principles
The architecture is deliberately minimal, focusing on:
- **One static-site deployment target**: GitHub Pages.
- **One dynamic service**: A single Cloudflare Worker.
- **No client-side JavaScript frameworks**: Vanilla TS is used for client-side functionality.
- **Fail-closed approach**: Critical configurations (e.g., `GITHUB_PAT`) cause explicit errors if unconfigured in production.

### Technology Stack
- **Static site**: Jekyll 4.3.x (Ruby 3.2.x) with `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives` plugins.
- **API**: Hono on Cloudflare Workers (TypeScript) for all dynamic backend services.
- **Smart Contracts**: Solidity 0.8.24, Foundry, targeting Base mainnet and Base Sepolia.
- **Authentication**: SIWE (Sign-in with Ethereum) using `siwe@^2.3.2` for message verification and `viem` for address validation. Sessions are HS256 JWTs with a revoke list in Cloudflare KV.
- **Wallet Client**: Client-side authentication uses `viem` and `window.ethereum` for injected provider interaction.
- **Project Management**: "Repo-as-Project" model where each artist project is a GitHub repository created from a template via the GitHub API. The Worker manages GitHub interactions.
- **Profile, Portfolio & Follow (Task #5, live)**: Artist pages live at `/@{handle}/` rendered by `_layouts/profile.html` (Jekyll `_authors` collection, permalink `/@:slug/`, default layout via `_config.yml` defaults). Project detail at `/p/?id=N` (single static page hydrated from `/v1/projects/:id`; integer IDs can't be statically routed by Jekyll, hence the query-param convention). Profile editor at `/dashboard/profile/`. New D1 columns on `users`: `display_name`, `socials` (JSON-encoded array of `{label,url}`), `cover_image` (migration `0003_user_profile_extras.sql`). New worker endpoints (all under `/v1`): `GET /users/:handle` (auth-aware payload — anonymous gets `Cache-Control: public, max-age=60, stale-while-revalidate=300`; authed gets `private, no-store` + `Vary: Cookie` to prevent the `is_self`/`is_following` keys from leaking through shared caches), `PATCH /me`, `POST/DELETE /users/:handle/follow` (60/hr rate limit per uid, idempotent), `GET /users/:handle/followers|following`. Validation: handle regex `^[a-z0-9][a-z0-9-]{1,30}$` plus a reserved-word set, `display_name` ≤60, `bio` ≤500, max 8 socials, **HTTPS-only** for `avatar_url`/`cover_image`/social URLs. PATCH /v1/me writes D1 (source of truth) and best-effort commits a freshly-rendered `_authors/{handle}.md` to the `GITHUB_SITE_REPO` (default `generatedart/generatedart`) so the static page refreshes on the next Pages build; the response always carries a `github_status: { committed, reason? }` so the editor can tell the user "static page won't refresh" without failing the save. On handle rename, the old `_authors/{old}.md` is deleted in the same pass so the old `/@old/` 404s. Mock mode and missing `GITHUB_SITE_REPO` short-circuit gracefully (D1 still updates). Three new TS bundles `assets/js/{ga-profile.js,ga-project-detail.js,ga-profile-editor.js}` (3.0–3.6 kB each).
- **Sketch Studio (Task #4, live)**: `/studio?project={id}` mounts CodeMirror 6 with a brand-aligned light theme (paper #FAFAF7 / ink #0A0A0A / accent #E63946 syntax highlighting derived from `assets/css/brand.css` tokens, replacing the earlier oneDark default). apiBase auto-derives to `https://api.{rootDomain}` in production, `http://localhost:8787` for localhost/Replit-preview hosts; `?api=` query param still overrides for ad-hoc dev. The sandboxed `/studio/preview/` iframe (`sandbox="allow-scripts"`, no parent DOM access; strict CSP `<meta>` allowing only the p5 CDN; postMessage handlers on both sides validate `event.source` identity since the null-origin iframe has no usable origin). Worker endpoints, all auth + ownership: `GET /v1/projects/:id/file`, `POST /v1/projects/:id/commit` (compare-and-swap on blob SHA, 256 KB cap, default message `studio: {ISO}`), `POST /v1/projects/:id/captures` (5 MB PNG cap, 60/hr per uid), `GET /v1/captures/:rest+` (allowlist regex `^captures/\d+/[A-Za-z0-9._-]+\.png$`, immutable cache headers). `⌘S` commits, `⌘E` exports the canvas → R2 → clipboard with a local-download fallback if R2 isn't bound. Autosaves to `localStorage` every 5 s and on blur/visibilitychange; the "Restore?" banner explicitly distinguishes "newer than remote" from "remote was updated elsewhere" by comparing the snapshot's `remoteSha` to the current blob sha. **Prod prerequisite**: before the first `wrangler deploy --env production`, run `wrangler r2 bucket create generatedart-assets` — the binding is now active in `[env.production]` and `CAPTURES_PUBLIC_BASE=https://api.generatedart.com` is pinned in `[env.production.vars]`.
- **Database**: Cloudflare D1 (SQLite) with migrations managed via SQL files. Includes 8 tables for users, projects, follows, briefs, applications, galleries, gallery_projects, and mints, plus an FTS5 virtual table for search.
- **UI/UX**: Minimalist brand-focused design with custom CSS (`assets/css/brand.css`) enforcing specific UI rules (e.g., no box shadows, hairline borders, accent color for primary CTAs). Favicon and OG images are also branded.
- **CI/CD**: GitHub Actions for Jekyll build/deploy, Worker deploy, and Foundry contract build/test.

### Key Features
- **Generative Art Platform**: Supports p5.js, three.js, WebGL, GLSL.
- **NFT Marketplace**: Planned integration for minting on Base Sepolia.
- **User Authentication**: Secure SIWE-based login with rate limiting.
- **Project Creation & Management**: Users can create, update, and archive projects, each backed by a GitHub repository.
- **Code Studio**: An in-browser editor for creative coding with live preview and direct commit functionality to GitHub.
- **Capture Functionality**: Allows capturing canvas outputs and storing them in Cloudflare R2.
- **Dashboard**: Provides a user interface for managing personal projects.

## External Dependencies
- **GitHub**: Used for source code management, project templating, and direct interaction via the GitHub API for project creation and updates.
- **Cloudflare Workers**: Primary dynamic service platform.
- **Cloudflare D1**: SQLite-compatible serverless database.
- **Cloudflare KV**: Key-value store for sessions and rate limiting.
- **Cloudflare R2**: Object storage for captures.
- **Cloudflare Web3 Ethereum Gateway**: Planned for RPC.
- **Pinata**: Planned for IPFS.
- **web3.storage**: Planned for IPFS.
- **WalletConnect v2**: Planned for wallet connectivity.
- **Viem**: Ethereum JavaScript library for wallet interactions.
- **Wagmi**: React Hooks for Ethereum (planned for client-side).
- **Jekyll**: Static site generator.
- **Hono**: Web framework for Cloudflare Workers.
- **SIWE (Sign-in with Ethereum)**: For user authentication.