# Self-hosting GeneratedArt

The platform is community-runnable. Anyone can fork the org and run a parallel instance.

## What you need

- A GitHub organization (e.g. `MyArtCollective`)
- A Cloudflare account with Workers Paid ($5/mo) — required for D1, Queues, Browser Rendering
- Pinata + web3.storage accounts for IPFS pinning
- A Base (or other EVM L2) wallet for the steward multisig
- Optional: Sentry, custom domain

## One-time setup

1. Fork `GeneratedArt/platform` to `<your-org>/platform`.
2. Create Cloudflare resources:
   ```bash
   wrangler d1 create generatedart
   wrangler kv namespace create SESSIONS
   wrangler kv namespace create RATE_LIMIT
   wrangler kv namespace create INDEXER_STATE
   wrangler r2 bucket create generatedart-assets
   wrangler queues create render-jobs
   wrangler queues create ipfs-pin-jobs
   ```
   Replace the `REPLACE_WITH_*` placeholders in each `workers/*/wrangler.toml`.
3. Create a GitHub App in your org with `contents:rw`, `pull_requests:rw`, `issues:rw`, `workflows:rw`. Install it on `<your-org>/*`. Save the App ID, private key, and webhook secret to Worker Secrets.
4. Deploy the steward multisig (Safe) on Base. Set `STEWARD_ADDRESS` and `PLATFORM_ADDRESS`.
5. Deploy the factory:
   ```bash
   cd contracts && forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
   ```
   Commit the resulting address to `contracts/deployments/base.json` and update the indexer's `FACTORY_ADDRESS`.
6. `pnpm -r deploy` to ship all Workers.
7. Deploy `site/` and `app/` to Cloudflare Pages.

## Customization

- Charter: edit `governance/CHARTER.md` in your governance repo.
- Brand: replace `site/assets/images/logo*.png`, edit `site/_config.yml`.
- Splits: adjust `RoyaltySplitter`'s `ARTIST_BPS` / `PLATFORM_BPS` / `GALLERY_BPS` constants.
- Allowlist: edit dependency allowlist in `.github/workflows/validate-bundle.yml`.
