// Determinism regression for the real bundler.
//
// We bundle workers/api/src/lib/freeze.ts via esbuild into a node-
// compatible ESM module, then call buildBundle() twice with identical
// inputs and once with a one-byte sketch change. The test asserts:
//   * identical inputs → byte-identical bundle, identical sha256,
//     identical CID, identical bundle_hash;
//   * one-byte change → different bundle_hash + CID;
//   * the CID we produce starts with `bafk` (CIDv1 raw multibase).
//
// We pass a stub runtime ({ p5: "/*p5-stub*/", three: "/*three-stub*/"})
// rather than the real ~1 MB vendored runtime so the test stays fast
// and its hash output is human-inspectable. The Worker code uses the
// real vendored sources at runtime; the determinism property the
// test exercises is independent of which runtime string is supplied.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const tmp = mkdtempSync(join(tmpdir(), "ga-freeze-"));
const outFile = join(tmp, "freeze.mjs");

// esbuild plugin: intercept the wrangler-Text imports of the
// vendored runtimes and replace them with tiny inline stub strings.
// Wrangler's `[[rules]] type="Text"` doesn't apply when bundling
// outside a Worker, so we substitute manually here.
const stubVendorPlugin = {
  name: "stub-vendor",
  setup(b) {
    b.onResolve({ filter: /(^|\/)(p5|three)\.min\.js$/ }, (args) => ({
      path: args.path,
      namespace: "stub-vendor",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub-vendor" }, (args) => {
      const tag = args.path.includes("p5") ? "/*p5-stub*/" : "/*three-stub*/";
      return {
        contents: `export default ${JSON.stringify(tag)};`,
        loader: "js",
      };
    });
  },
};

await build({
  entryPoints: ["workers/api/src/lib/freeze.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  plugins: [stubVendorPlugin],
  logLevel: "error",
});

const mod = await import(pathToFileURL(outFile).href);

// Mock env — bypass GitHub fetches via env.GITHUB_MOCK=1 and seed
// the mock store implicitly via getRepoFile's "first read"
// starter-sketch path. To make the test self-contained we instead
// inject a fake repo by passing repoFull=null (synthetic 1-file
// tree) and varying the "title" / "engine" inputs.
const env = { GITHUB_MOCK: "1" };

const inputA = {
  repoFull: null,
  engine: "p5",
  title: "Drift Test",
  commit: "deadbeef",
  projectId: 7,
};
const runtime = { p5: "/*p5-stub*/", three: "/*three-stub*/" };

const a1 = await mod.buildBundle(env, inputA, runtime);
const a2 = await mod.buildBundle(env, inputA, runtime);

assert.equal(a1.bytes.length, a2.bytes.length, "byte length must match");
assert.equal(
  Buffer.compare(Buffer.from(a1.bytes), Buffer.from(a2.bytes)),
  0,
  "identical input must produce byte-identical bundle",
);
assert.equal(a1.bundle_hash, a2.bundle_hash, "bundle_hash must match");
assert.equal(a1.local_cid, a2.local_cid, "local CID must match");
assert.ok(a1.local_cid.startsWith("bafk"), "CID should be CIDv1 raw");

// Now vary the "title" by one character — different input → different
// hash. (Synthetic tree means we can't easily vary the sketch source
// directly without mocking the GitHub API, but title flows through
// htmlEscape into the canonical bundle the same way.)
const b1 = await mod.buildBundle(
  env,
  { ...inputA, title: "Drift Test." },
  runtime,
);
assert.notEqual(a1.bundle_hash, b1.bundle_hash, "one-char change → different bundle_hash");
assert.notEqual(a1.local_cid, b1.local_cid, "one-char change → different CID");

console.log("bundle_hash A =", a1.bundle_hash);
console.log("bundle_hash B =", b1.bundle_hash);
console.log("local_cid   A =", a1.local_cid);
console.log("local_cid   B =", b1.local_cid);
console.log("OK: deterministic bundler + drift detection both confirmed.");
