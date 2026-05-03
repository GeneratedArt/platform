# GeneratedArt — Platform Monorepo

## Overview
GeneratedArt is a community-run generative art platform and NFT marketplace focused on code-based generative art (p5.js / three.js / WebGL / GLSL). It aims to be a spiritual successor to platforms like fxhash and Art Blocks, incorporating a physical-digital bridge through the Geneva gallery. The project prioritizes a streamlined architecture: Cloudflare Pages serves the Jekyll static site, and a Cloudflare Worker handles all dynamic services.

## User Preferences
Not specified in the original document.

## System Architecture

### Core Design Principles
The architecture is deliberately minimal, focusing on:
- **One static-site deployment target**: Cloudflare Pages.
- **One dynamic service**: A single Cloudflare Worker.
- **No client-side JavaScript frameworks**: Vanilla TS is used.
- **Fail-closed approach**: Critical configurations cause explicit errors if unconfigured in production.

### Technology Stack
- **Static site**: Jekyll 4.3.x (Ruby 3.2.x) with `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives` plugins.
- **API**: Hono on Cloudflare Workers (TypeScript).
- **Smart Contracts**: Solidity 0.8.24, Foundry, targeting Base mainnet and Base Sepolia.
- **Authentication**: SIWE (Sign-in with Ethereum) using `siwe@^2.3.2` for message verification and `viem` for address validation. Sessions are HS256 JWTs with a revoke list in Cloudflare KV.
- **Wallet Client**: Client-side authentication uses `viem` and `window.ethereum`.
- **Database**: Cloudflare D1 (SQLite) with migrations managed via SQL files, including 10 tables and an FTS5 virtual table for search.

### Key Features
- **Generative Art Platform**: Supports p5.js, three.js, WebGL, GLSL.
- **NFT Marketplace**: ERC-721 + ERC-2981 mint flow on Base Sepolia. `GAProject` (per-project clone) + `GAProjectFactory` (EIP-1167 minimal proxies).
- **Briefs Board**: Open commission and collaboration calls with industry filter chips.
- **User Authentication**: Secure SIWE-based login with rate limiting.
- **Project Creation & Management**: Users can create, update, and archive projects, each backed by a GitHub repository.
- **Code Studio**: An in-browser editor for creative coding with live preview and direct commit functionality to GitHub.
- **Capture Functionality**: Allows capturing canvas outputs and storing them in Cloudflare R2.
- **Discovery & Search**: `explore` page with Recent / Trending / Featured tabs, and a `search` page leveraging FTS5 across users, projects, and briefs.
- **OG Cards**: Server-rendered HTML for project-specific `og:*` + `twitter:*` meta tags for improved link sharing.
- **Frozen Artifact & Provenance Pipeline**: Ensures every mintable project resolves to an immutable, content-addressed bundle. Includes a bundler, dual IPFS pinning (web3.storage and Pinata), a `frozen_versions` table, API endpoints for freezing and activating versions, a mint guard requiring an active frozen version, and a nightly cron for pin health checks.
- **Activity Feed & Notifications (Task #17)**: Append-only `events` table (migration `0013_events.sql`) with composite index `(recipient_id, created_at DESC, id DESC)` for sub-50ms feed reads at 100k rows. `recordEvent()` helper in `workers/api/src/db/events.ts` is called best-effort (try/catch wrapped) from commit, freeze, mint, follow, and brief-post handlers — feed write failures never abort the primary action. Endpoints: `GET /v1/feed` (followed-graph public events with empty-state suggestions from explore trending), `GET /v1/notifications` (rows where `recipient_id = viewer`, includes unread count for the bell badge), `POST /v1/notifications/read` (per-id or `{all:true}`). 50-row page cap, keyset cursor `<created_at>:<id>`. `/feed/index.html` Jekyll page with infinite scroll. Global bell drawer mounted into the nav-10 partial by `assets/js/ga-feed.js` and styled by `assets/css/ga-bell.css`; both are loaded from `_includes/core/scripts/scripts.html` so the bell appears site-wide for signed-in viewers.
- **UI/UX**: Minimalist brand-focused design with custom CSS enforcing specific UI rules (e.g., no box shadows, hairline borders, accent color for primary CTAs).
- **CI/CD**: Cloudflare Pages auto-builds the Jekyll static site on every push to `main`. Worker deployment is manual. Foundry contracts are built/tested locally.

## External Dependencies
- **GitHub**: Source code management, project templating, and direct interaction via GitHub API.
- **Cloudflare Pages**: Static-site hosting.
- **Cloudflare Workers**: Primary dynamic service platform.
- **Cloudflare D1**: SQLite-compatible serverless database.
- **Cloudflare KV**: Key-value store.
- **Cloudflare R2**: Object storage for captures.
- **Viem**: Ethereum JavaScript library for wallet interactions.
- **Jekyll**: Static site generator.
- **Hono**: Web framework for Cloudflare Workers.
- **SIWE (Sign-in with Ethereum)**: User authentication.