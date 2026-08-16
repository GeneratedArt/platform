# Vendored runtimes

`src/lib/freeze.ts` imports these two files as raw text (see the `[[rules]]`
`type = "Text"` block in `wrangler.toml`) and inlines them into the
self-contained HTML bundle it pins to IPFS. They are **committed on purpose**:

* The bundler runs inside a Worker — it cannot fetch a CDN at freeze time and
  still be deterministic.
* `bundle_hash` covers the runtime source (`__meta__/runtime` in the manifest),
  so a runtime bump must be an explicit, reviewable commit. A floating CDN URL
  would silently change every future bundle's hash.
* Without these files on disk `wrangler deploy` fails at build time with
  `ENOENT: no such file or directory, open '.../vendor/p5.min.js'`.

## Pinned versions

| File           | Package | Version  | Source path in the npm tarball |
| -------------- | ------- | -------- | ------------------------------ |
| `p5.min.js`    | `p5`    | 1.9.4    | `lib/p5.min.js`                |
| `three.min.js` | `three` | 0.160.1  | `build/three.min.js`           |

## Refreshing

```sh
npm run vendor:sync            # re-fetches the pinned versions above
```

Bump the versions in the `vendor:sync` script when you want a newer runtime,
run it, and commit the diff. Note that three.js dropped the UMD
(`build/three.min.js`) build after r160 — the frozen bundle loads the runtime
via a classic `<script>` tag, so it needs a global build, not an ES module.
Moving past r160 means teaching `renderHtml()` to emit
`<script type="module">` first.
