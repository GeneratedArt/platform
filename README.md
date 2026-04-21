# GeneratedArt — Platform

A community-run generative art platform and NFT marketplace for code-based generative art (hand-written p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge inherited from the existing GeneratedArt brand.

> **Stack:** GitHub + Jekyll + Cloudflare (Pages, Workers, D1, KV, R2, Queues) + Base (L2). No traditional servers. No AWS, Vercel, Firebase, Supabase, Mongo, Stripe-as-primary-rails.

## Monorepo layout

```
platform/
├── site/         Jekyll public site → Cloudflare Pages (generatedart.com)
├── app/          Astro app          → Cloudflare Pages (app.generatedart.com)
├── workers/
│   ├── api/         REST API (Hono on Workers)
│   ├── github-bot/  GitHub App webhook handler
│   ├── indexer/     Cron-triggered chain indexer
│   ├── renderer/    IPFS proxy + token-hash injection + capture
│   └── shared/      Drizzle schemas, zod types
├── contracts/    Foundry project (GenArtFactory, GenArtProject, RoyaltySplitter)
├── .github/      CI workflows + CODEOWNERS
├── docs/         Architecture, contributor guide, audit reports
└── scripts/      bootstrap.sh, seed.sql
```

## Quickstart

```bash
./scripts/bootstrap.sh   # installs Ruby gems, pnpm deps, Foundry, seeds local D1
pnpm dev                 # runs site + app + api + renderer concurrently
```

See [`docs/architecture.md`](./docs/architecture.md) for the full system design and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to fork and self-host the org.

## License

MIT for platform code. Artist bundles are licensed individually (default CC-BY-NC-4.0).
