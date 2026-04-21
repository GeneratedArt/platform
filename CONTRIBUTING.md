# Contributing to GeneratedArt

GeneratedArt is community-runnable. Anyone should be able to fork the org and stand up a parallel instance.

## Local development

Requirements: Ruby 3.2+, Node 20+, pnpm 9+, Foundry (for contracts).

```bash
git clone https://github.com/GeneratedArt/platform.git
cd platform
./scripts/bootstrap.sh
pnpm dev
```

Services:
- Jekyll site — http://localhost:4000
- Astro app — http://localhost:4321
- API Worker — http://localhost:8787
- Renderer Worker — http://localhost:8788

## Roles

| Role | How you become one |
|------|--------------------|
| Visitor | No account |
| Collector | Connect a wallet (SIWE) |
| Artist | Apply via `/apply`, approved by curators |
| Gallery Partner | Apply, approved by stewards |
| Curator | Elected via GitHub Discussions poll in `GeneratedArt/governance` |
| Steward | Multisig signer; governs charter amendments |

## Pull requests

- All PRs require CODEOWNERS approval (curators for project repos, stewards for platform infra).
- CI must pass: `validate-bundle.yml` for project bundles, `test-contracts.yml` for Solidity, `build-site.yml` for Jekyll.
- Never commit secrets. `git-secrets` pre-commit hook is wired in `bootstrap.sh`.

## Forking the org

See [`docs/self-hosting.md`](./docs/self-hosting.md). All Cloudflare resource IDs are placeholders in `wrangler.toml`; replace them with your own.
