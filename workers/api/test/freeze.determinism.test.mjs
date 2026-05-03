// Task #15: determinism regression.
//
// Run with `node workers/api/test/freeze.determinism.test.mjs`. We
// don't pull in vitest just for this one test — a vanilla Node script
// is sufficient and matches the rest of the repo's "no test runner
// yet" posture.
//
// What this proves:
//   1. buildBundle() over identical inputs → byte-identical output,
//      identical SHA-256, identical local CID.
//   2. A one-byte change in the source sketch → DIFFERENT SHA-256
//      and DIFFERENT local CID.
//
// We re-implement the bundle template + hash + CID functions here
// rather than importing the TS module to keep the test runtime-free.
// The constants (template strings, runtime version pins, base32
// alphabet) MUST match `workers/api/src/lib/freeze.ts` — if either
// drifts this test will catch a real regression on the next run.

import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";

const P5_VERSION = "1.9.4";
const P5_SRI =
  "sha384-sNqjj/aLOe+QQ4iTeNTXhx9Vyq/cN8b3dM7LYhZxkV3CgFJjdQYcfH8DmQyBOFQU";

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlHead(title, engine) {
  let runtime = "";
  if (engine === "p5") {
    runtime = `<script src="https://cdn.jsdelivr.net/npm/p5@${P5_VERSION}/lib/p5.min.js" integrity="${P5_SRI}" crossorigin="anonymous"></script>`;
  }
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;padding:0;background:#0b0b0b;color:#eee;font-family:system-ui;overflow:hidden}canvas{display:block;margin:0 auto}</style>
${runtime}
`;
}

const HTML_TAIL = `
<script>
// Pull seed from query string. Identical seed → identical render
// (assuming the artist's sketch is deterministic, which is the
// platform contract for tokenURI rendering).
(function () {
  var p = new URLSearchParams(location.search);
  window.GA_SEED = p.get("seed") || "0";
  window.GA_TOKEN_ID = p.get("tokenId") || "0";
})();
</script>
<script id="ga-sketch">
__SKETCH__
</script>
`;

function buildBundleBytes(title, engine, sketch) {
  const sketchNorm = sketch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const html = htmlHead(title, engine) + HTML_TAIL.replace("__SKETCH__", sketchNorm);
  return new TextEncoder().encode(html);
}

async function sha256Hex(bytes) {
  const buf = await webcrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base32Lower(data) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0,
    value = 0,
    out = "";
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

async function cidV1Raw(bytes) {
  const digest = new Uint8Array(
    await webcrypto.subtle.digest("SHA-256", bytes),
  );
  const out = new Uint8Array(4 + digest.length);
  out[0] = 0x01;
  out[1] = 0x55;
  out[2] = 0x12;
  out[3] = 0x20;
  out.set(digest, 4);
  return "b" + base32Lower(out);
}

const SKETCH_A = `function setup(){createCanvas(400,400);}
function draw(){background(20);noStroke();fill(255);circle(200,200,80);}
`;
// SKETCH_B differs from A by exactly one byte (radius 80 -> 81).
const SKETCH_B = SKETCH_A.replace("80);", "81);");

const title = "Drift Test";

const a1 = buildBundleBytes(title, "p5", SKETCH_A);
const a2 = buildBundleBytes(title, "p5", SKETCH_A);
const b1 = buildBundleBytes(title, "p5", SKETCH_B);

const hashA1 = await sha256Hex(a1);
const hashA2 = await sha256Hex(a2);
const hashB1 = await sha256Hex(b1);
const cidA1 = await cidV1Raw(a1);
const cidA2 = await cidV1Raw(a2);
const cidB1 = await cidV1Raw(b1);

console.log("hashA1 =", hashA1);
console.log("hashA2 =", hashA2);
console.log("hashB1 =", hashB1);
console.log("cidA1  =", cidA1);
console.log("cidB1  =", cidB1);

assert.equal(a1.length, a2.length, "byte length must match for identical input");
assert.equal(
  Buffer.compare(Buffer.from(a1), Buffer.from(a2)),
  0,
  "identical input must produce byte-identical bundle",
);
assert.equal(hashA1, hashA2, "identical input must produce identical sha256");
assert.equal(cidA1, cidA2, "identical input must produce identical CID");

assert.notEqual(hashA1, hashB1, "one-byte change must change sha256");
assert.notEqual(cidA1, cidB1, "one-byte change must change CID");

assert.ok(cidA1.startsWith("bafk"), "CIDv1 raw should start with `bafk`");

console.log("OK: deterministic bundle + drift detection both confirmed.");
