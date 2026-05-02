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
- **Sketch Studio**: Features CodeMirror 6 for editing and a sandboxed iframe for live preview. Supports committing changes to GitHub and capturing canvas outputs to R2.
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