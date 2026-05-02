# GeneratedArt — Platform

Community-run generative art platform and NFT marketplace for code-based generative art (hand-written p5.js / three.js / WebGL / GLSL). Spiritual successor to fxhash and Art Blocks, with a physical-digital bridge through the Geneva gallery.

> **Stack.** Static site on **GitHub Pages** (Jekyll, derived from a GeneratedArt-template foundation — see `_includes/generatedart-attribution.html`). Dynamic services on **Cloudflare** (Workers + D1 + KV + R2 + Queues). Smart contracts on **Base L2** (Foundry). No AWS, Vercel, Firebase, Supabase, Mongo, or Stripe-as-primary-rails.

## Layout

```
platform/
├── _config.yml, _layouts/, _includes/, _data/, _posts/, ...   Jekyll site (root)
├── assets/, blogs/, portfolios/, services/, ...               Template content (to be replaced by GA features)
├── CNAME                                                       generatedart.com
├── workers/
│   └── api/        Hono Worker — /health (foundation only)
├── contracts/      Foundry suite (placeholder; suite will be re-added)
└── .github/workflows/
    ├── pages.yml         Jekyll build + GitHub Pages deploy
    ├── worker-api.yml    Wrangler deploy → api.generatedart.com
    └── contracts.yml     forge build + test
```

## Local dev

```bash
bundle install                     # one-time
bundle exec jekyll serve           # http://localhost:5000
```

The Replit "Start application" workflow runs the same command on port 5000.

For the API Worker:

```bash
cd workers/api && npm install && npm run dev    # http://localhost:8787/health
```

## Deploy

| Surface         | Where             | How                                                   |
|-----------------|-------------------|-------------------------------------------------------|
| Static site     | GitHub Pages      | `pages.yml` on push to `main` (Settings → Pages → Source: GitHub Actions) |
| API Worker      | Cloudflare Workers| `worker-api.yml` on push to `workers/api/**`           |
| Contracts       | Base L2           | `forge script script/Deploy.s.sol --rpc-url base --broadcast` |

## License

MIT for platform code. Artist bundles licensed individually (default CC-BY-NC-4.0).
