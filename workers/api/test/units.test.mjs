// Unit regressions for pure logic in src/. Each block pins a bug that
// shipped at least once; the comment names the failure it prevents.
//
// The Worker sources are TypeScript, so we bundle the handful of
// exported helpers under test into one ESM module with esbuild (same
// approach as freeze.determinism.test.mjs) rather than adding a
// TS-aware test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(pkgDir, "src");
// The bundle must live inside the package so Node can still resolve the
// externals (`siwe`, `hono`, `viem`) from node_modules at import time —
// a bundle written to the OS temp dir cannot.
const cacheRoot = join(pkgDir, "node_modules", ".cache");
mkdirSync(cacheRoot, { recursive: true });
const tmp = mkdtempSync(join(cacheRoot, "ga-units-"));
const outFile = join(tmp, "units.mjs");
const entry = join(tmp, "entry.ts");

writeFileSync(
  entry,
  `export { checkSiweBinding } from ${JSON.stringify(join(srcDir, "auth", "siwe"))};
export { sanitizeRoute, minuteBucket } from ${JSON.stringify(join(srcDir, "lib", "metrics"))};
export { buildFtsQuery } from ${JSON.stringify(join(srcDir, "db", "search"))};
export { parseAllowlist } from ${JSON.stringify(join(srcDir, "auth", "admin"))};
export { parseFeedCursor, encodeFeedCursor } from ${JSON.stringify(join(srcDir, "db", "events"))};
export { lifetimeDeltas } from ${JSON.stringify(join(srcDir, "db", "tokens"))};
export { providerAllowedForKind } from ${JSON.stringify(join(srcDir, "db", "render"))};
`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  // hono/siwe/viem are only imported for types in these modules, but the
  // bundler still resolves the value imports in the same files. Marking
  // them external keeps the bundle to our own code.
  external: ["hono", "hono/*", "siwe", "viem"],
  logLevel: "error",
});

const m = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// SIWE origin binding.
//
// Regression: the check reconstructed an origin as `https://${domain}`
// because SIWE messages carry no scheme by default. Every http:// entry
// in ALLOWED_ORIGINS was therefore unmatchable and sign-in against a
// local dev origin failed with domain_not_allowed — which cascaded into
// every authenticated route being untestable.
// ---------------------------------------------------------------------------
test("SIWE binding accepts an http origin from ALLOWED_ORIGINS", () => {
  const allowed = "http://localhost:5000,http://127.0.0.1:5000";
  assert.equal(
    m.checkSiweBinding(allowed, {
      domain: "localhost:5000",
      uri: "http://localhost:5000",
    }),
    "ok",
  );
});

test("SIWE binding accepts an https production origin", () => {
  const allowed = "https://generatedart.com,https://www.generatedart.com";
  assert.equal(
    m.checkSiweBinding(allowed, {
      domain: "generatedart.com",
      uri: "https://generatedart.com/studio/",
    }),
    "ok",
  );
  assert.equal(
    m.checkSiweBinding(allowed, {
      domain: "www.generatedart.com",
      uri: "https://www.generatedart.com",
    }),
    "ok",
  );
});

test("SIWE binding rejects a foreign domain", () => {
  assert.equal(
    m.checkSiweBinding("https://generatedart.com", {
      domain: "evil.example.com",
      uri: "https://evil.example.com",
    }),
    "domain_not_allowed",
  );
});

test("SIWE binding rejects a uri pointing at another host", () => {
  // The signer states an allowed domain but a uri for somewhere else —
  // the shape a phishing page would produce to get a signature it can
  // replay against us.
  assert.equal(
    m.checkSiweBinding("https://generatedart.com", {
      domain: "generatedart.com",
      uri: "https://evil.example.com/callback",
    }),
    "uri_domain_mismatch",
  );
});

test("SIWE binding rejects an unparseable uri", () => {
  assert.equal(
    m.checkSiweBinding("https://generatedart.com", {
      domain: "generatedart.com",
      uri: "not a url",
    }),
    "invalid_siwe_uri",
  );
});

test("SIWE binding tolerates a bare host entry and blank list items", () => {
  assert.equal(
    m.checkSiweBinding("generatedart.com, ,https://www.generatedart.com", {
      domain: "generatedart.com",
    }),
    "ok",
  );
});

test("SIWE binding is not fooled by a suffix match", () => {
  assert.equal(
    m.checkSiweBinding("https://generatedart.com", {
      domain: "notgeneratedart.com",
    }),
    "domain_not_allowed",
  );
  assert.equal(
    m.checkSiweBinding("https://generatedart.com", {
      domain: "generatedart.com.evil.example",
    }),
    "domain_not_allowed",
  );
});

// ---------------------------------------------------------------------------
// Metrics route labelling.
//
// Regression: Hono's routePath includes the inline regex constraint
// (`/v1/projects/:id{[0-9]+}`), whose braces/brackets failed the
// allowlist. Every parameterised route — projects, mint, freeze,
// galleries, captures — collapsed into a single `_invalid` bucket, which
// was by far the largest row in /v1/internal/stats#by_route.
// ---------------------------------------------------------------------------
test("route labels keep parameterised routes distinguishable", () => {
  assert.equal(m.sanitizeRoute("/v1/projects/:id{[0-9]+}"), "/v1/projects/:id");
  assert.equal(
    m.sanitizeRoute("/v1/projects/:id{[0-9]+}/mint/prepare"),
    "/v1/projects/:id/mint/prepare",
  );
  assert.equal(
    m.sanitizeRoute("/v1/projects/:id{[0-9]+}/frozen/:fid{[0-9]+}/activate"),
    "/v1/projects/:id/frozen/:fid/activate",
  );
  assert.equal(
    m.sanitizeRoute("/v1/galleries/:slug{[a-z0-9-]+}"),
    "/v1/galleries/:slug",
  );
  assert.equal(m.sanitizeRoute("/v1/captures/:rest{.+}"), "/v1/captures/:rest");
});

test("route labels pass plain routes through unchanged", () => {
  assert.equal(m.sanitizeRoute("/health"), "/health");
  assert.equal(m.sanitizeRoute("/v1/users/:handle"), "/v1/users/:handle");
});

test("route labels still reject genuinely unexpected input", () => {
  assert.equal(m.sanitizeRoute("/v1/x?<script>"), "_invalid");
  assert.equal(m.sanitizeRoute("/v1/x\nInjected: 1"), "_invalid");
});

test("route labels are length-capped", () => {
  assert.ok(m.sanitizeRoute("/" + "a".repeat(500)).length <= 120);
});

// ---------------------------------------------------------------------------
// FTS query construction — users must not be able to inject FTS5 syntax.
// ---------------------------------------------------------------------------
test("FTS query strips operators and prefixes each token", () => {
  assert.equal(m.buildFtsQuery("drift study"), "drift* OR study*");
  assert.equal(m.buildFtsQuery("smoke AND (drift"), "smoke* OR and* OR drift*");
  assert.equal(m.buildFtsQuery("   "), null);
  assert.equal(m.buildFtsQuery("a"), null); // single char is below the floor
});

test("FTS query never emits FTS5 syntax from user input", () => {
  // Everything outside [a-z0-9] is dropped, so quotes, parens, NEAR/
  // column filters and the `--` comment marker cannot survive into the
  // MATCH expression. Surviving alphanumeric runs are always literal
  // prefix terms joined by our own OR.
  const hostile = [
    '" OR 1=1 --',
    'title:"x" NEAR/2 y',
    "a* OR b* OR (c AND d)",
    "^start end$",
    "\\\"; DROP TABLE users;--",
  ];
  for (const q of hostile) {
    const out = m.buildFtsQuery(q);
    if (out === null) continue;
    assert.match(
      out,
      /^[a-z0-9]{2,32}\*( OR [a-z0-9]{2,32}\*)*$/,
      `unsafe FTS expression from ${JSON.stringify(q)}: ${out}`,
    );
  }
});

test("FTS tokens are length-capped", () => {
  const out = m.buildFtsQuery("x".repeat(200));
  assert.equal(out, "x".repeat(32) + "*");
});

// ---------------------------------------------------------------------------
// Admin allowlist — closed by default, handle-shaped entries only.
// ---------------------------------------------------------------------------
test("admin allowlist is empty when unset or blank", () => {
  assert.deepEqual(m.parseAllowlist(undefined), []);
  assert.deepEqual(m.parseAllowlist(""), []);
  assert.deepEqual(m.parseAllowlist(" , , "), []);
});

test("admin allowlist keeps only handle-shaped entries", () => {
  assert.deepEqual(m.parseAllowlist("Alice, bob-x ,!nope,c"), ["alice", "bob-x"]);
  // An address is not a handle — pasting one in must not grant access.
  assert.deepEqual(
    m.parseAllowlist("0x5337e01b9808c0e4d92be9c9411fc52cdbc0bf61"),
    [],
  );
});

// ---------------------------------------------------------------------------
// Feed keyset cursors.
// ---------------------------------------------------------------------------
test("feed cursor round-trips", () => {
  const c = { created_at: 1786799220, id: 42 };
  assert.deepEqual(m.parseFeedCursor(m.encodeFeedCursor(c)), c);
});

test("feed cursor rejects malformed input rather than poisoning SQL", () => {
  for (const bad of ["garbage", "1:2:3", "", "-1:2", "1:-2", "a:b", "1"]) {
    assert.equal(m.parseFeedCursor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// Render-token ledger — lifetime counters.
//
// Regression this pins: a refund must NOT reduce lifetime_spent (a
// refunded render would otherwise read as having spent a negative
// amount), and only a genuine 'debit' should ever advance it.
// ---------------------------------------------------------------------------
test("lifetimeDeltas: purchase and grant both count as purchased", () => {
  assert.deepEqual(m.lifetimeDeltas("purchase", 500), {
    purchased: 500,
    spent: 0,
    earned: 0,
  });
  assert.deepEqual(m.lifetimeDeltas("grant", 200), {
    purchased: 200,
    spent: 0,
    earned: 0,
  });
});

test("lifetimeDeltas: debit counts as spent using the positive magnitude", () => {
  assert.deepEqual(m.lifetimeDeltas("debit", -30), {
    purchased: 0,
    spent: 30,
    earned: 0,
  });
});

test("lifetimeDeltas: refund advances nothing — it is not a negative spend", () => {
  assert.deepEqual(m.lifetimeDeltas("refund", 30), {
    purchased: 0,
    spent: 0,
    earned: 0,
  });
});

test("lifetimeDeltas: earn counts as earned only", () => {
  assert.deepEqual(m.lifetimeDeltas("earn", 21), {
    purchased: 0,
    spent: 0,
    earned: 21,
  });
});

test("lifetimeDeltas: adjust never touches a lifetime counter", () => {
  assert.deepEqual(m.lifetimeDeltas("adjust", 999), {
    purchased: 0,
    spent: 0,
    earned: 0,
  });
  assert.deepEqual(m.lifetimeDeltas("adjust", -999), {
    purchased: 0,
    spent: 0,
    earned: 0,
  });
});

// ---------------------------------------------------------------------------
// Render-model provider/kind gating.
//
// Regression this prevents: registering an image model against the
// code-only `anthropic` provider (or vice versa) would only fail once
// someone had already been charged for a job against it.
// ---------------------------------------------------------------------------
test("providerAllowedForKind: code models accept anthropic and mock only", () => {
  assert.equal(m.providerAllowedForKind("code", "anthropic"), true);
  assert.equal(m.providerAllowedForKind("code", "mock"), true);
  assert.equal(m.providerAllowedForKind("code", "workers_ai"), false);
});

test("providerAllowedForKind: image models accept workers_ai and mock only", () => {
  assert.equal(m.providerAllowedForKind("image", "workers_ai"), true);
  assert.equal(m.providerAllowedForKind("image", "mock"), true);
  assert.equal(m.providerAllowedForKind("image", "anthropic"), false);
});
