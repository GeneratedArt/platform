# GeneratedArt project template

This is the canonical starting point for every art project on
[generatedart.com](https://generatedart.com). The platform creates a fresh
copy of this repo at `GeneratedArt/art-<your-slug>` when your project is
approved.

## Local dev

Just open `index.html` in a browser, or serve the directory with any static
server:

```bash
npx serve .
```

The `$ga` SDK in `src/ga-sdk.js` exposes:

| API | Description |
|-----|-------------|
| `$ga.hash` | per-token deterministic hash (URL `?hash=` in dev) |
| `$ga.tokenId` | edition number (URL `?token=`) |
| `$ga.rand()` | seeded PRNG in `[0, 1)` — **use this instead of `Math.random()`** |
| `$ga.features` | object describing on-chain traits — populate before the first frame |
| `$ga.preview()` | call once the visual is stable; the renderer captures a still |

## Rules (enforced by `.github/workflows/validate-bundle.yml`)

- Zipped bundle ≤ **3 MB**
- `index.html` at the root
- No `fetch(`, `XMLHttpRequest`, `import(...)` calls
- No `Math.random()` — use `$ga.rand()`
- Vendored libraries only, from the allowlist (`p5`, `three`, `regl`, `tone`, `d3`)
- The same `$ga.hash` must produce a pixel-identical render across two runs

The validator workflow runs on every PR. Curators cannot merge until it passes.

## Releasing

1. Open a PR to `main` with the label `ready-for-review`.
2. Curators review and merge.
3. A maintainer pushes a `v1.0.0` tag — `release.yml` zips the bundle, pins to
   IPFS via Pinata, drops the CID into the release notes, and the GeneratedArt
   bot picks up the release event and triggers the on-chain factory deploy.

Once `live`, the tag is protected and the bundle is immutable. Material fixes
ship as a new project under a new contract.
