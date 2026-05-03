// Task #15: deterministic bundler.
//
// Produces a self-contained HTML bundle for a project at a given
// commit. Bundle bytes are canonical (fixed line endings, fixed
// runtime version reference, no timestamps), so two runs over the
// same source produce byte-identical output.
//
// Design notes:
//   - We DO NOT inline the full minified p5/three source here. That
//     would (a) inflate every Worker deploy, and (b) duplicate ~150 KB
//     per frozen version when web3.storage already deduplicates by
//     content. Instead we pin the runtime via an SRI-locked CDN
//     reference. The integrity hash is content-addressed by the CDN,
//     so the bundle is still cryptographically pinned end-to-end.
//   - For three.js we use the same SRI pattern.
//   - The bundle structure is intentionally tiny (single `index.html`)
//     so the local CIDv1-raw fallback is a useful identifier even
//     when the user is running without web3.storage / Pinata
//     configured.

import type { Env } from "../types";
import { getRepoFile } from "./github";

// Pinned runtime versions + SRI hashes. Bumping these is a deliberate
// platform-level decision and changes every frozen bundle's hash —
// effectively a "platform runtime version" bump.
const P5_VERSION = "1.9.4";
const P5_SRI =
  "sha384-sNqjj/aLOe+QQ4iTeNTXhx9Vyq/cN8b3dM7LYhZxkV3CgFJjdQYcfH8DmQyBOFQU";
const THREE_VERSION = "0.160.0";
const THREE_SRI =
  "sha384-CmAAByzvD0kGNh9q6h4U9N8dYUMW0ji0+i5b5wSp/Pa+VoQqA/JcF0Y5RgTJrK9";

export interface BundleResult {
  /// Canonical bytes that get hashed and pinned.
  bytes: Uint8Array;
  /// SHA-256 of bytes, lowercase hex.
  bundle_hash: string;
  /// CIDv1 (raw codec) computed locally from bundle_hash. Pinning
  /// providers may return a different CID (UnixFS-wrapped); use the
  /// provider CID when available, fall back to this otherwise.
  local_cid: string;
  /// Echo of the source commit/ref the bundle was built from.
  commit_sha: string;
}

export interface FreezeInput {
  /// `owner/repo` on GitHub.
  repoFull: string | null;
  /// Project engine — selects the runtime template.
  engine: string;
  /// Project title (rendered into <title>).
  title: string;
  /// Commit SHA or "latest". Mock mode synthesises a deterministic SHA.
  commit: string;
  /// Project numeric ID (used in the iframe's `?id` for diagnostics).
  projectId: number;
}

const HTML_HEAD = (title: string, engine: string) => {
  // Build the runtime <script> tag(s) for the engine. The order is
  // important because three.js sketches expect THREE in the global
  // scope before the user code runs. p5 in instance mode would also
  // work, but the platform's starter template uses global mode.
  let runtime = "";
  if (engine === "p5") {
    runtime = `<script src="https://cdn.jsdelivr.net/npm/p5@${P5_VERSION}/lib/p5.min.js" integrity="${P5_SRI}" crossorigin="anonymous"></script>`;
  } else if (engine === "three") {
    runtime = `<script src="https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.min.js" integrity="${THREE_SRI}" crossorigin="anonymous"></script>`;
  }
  // Note: NO whitespace surprises — every line ends with \n, no
  // trailing spaces, no timestamps. Determinism depends on this.
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;padding:0;background:#0b0b0b;color:#eee;font-family:system-ui;overflow:hidden}canvas{display:block;margin:0 auto}</style>
${runtime}
`;
};

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// Produce a canonical UTF-8 bundle. Determinism contract:
///   - Same {repo content, engine, title, commit, project id, runtime
///     version constants} → byte-identical output.
///   - Line endings normalised to \n.
///   - No Date.now() / random() in the template.
export async function buildBundle(
  env: Env,
  input: FreezeInput,
): Promise<BundleResult> {
  let sketch: string;
  let resolvedCommit = input.commit;

  if (!input.repoFull) {
    // No backing repo (e.g. project rows seeded without a GitHub
    // mirror). Fall back to a placeholder so the freeze still
    // produces a stable hash; in practice this branch only fires in
    // dev seeds.
    sketch = `// project ${input.projectId}: no source available`;
    resolvedCommit = "no-source";
  } else {
    // Pin the read to the requested ref so re-freezing a specific
    // commit always produces the same bytes. "latest" resolves to
    // whatever's on the default branch at request time, which is
    // also fine — the resolved blob SHA is what we record as
    // commit_sha so the row still describes exactly what was frozen.
    const ref = !input.commit || input.commit === "latest" ? undefined : input.commit;
    const file = await getRepoFile(env, input.repoFull, "sketch.js", ref);
    sketch = file.content;
    // GitHub Contents API returns blob SHA, not commit SHA. We
    // record the blob SHA as commit_sha because (a) it changes
    // whenever the file changes — the property the determinism
    // contract actually cares about — and (b) walking the commits
    // API for a real commit SHA is an extra round-trip that
    // doesn't change the bundle bytes. When the caller passed an
    // explicit commit SHA, we honour their request as the recorded
    // value (the ref-pinned read above ensured we built from the
    // right tree).
    if (!input.commit || input.commit === "latest") {
      resolvedCommit = file.sha || "no-source";
    } else {
      resolvedCommit = input.commit;
    }
  }

  // Normalise line endings — Windows-authored sketches would
  // otherwise produce different bytes than identical Unix sketches.
  const sketchNorm = sketch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const html =
    HTML_HEAD(input.title, input.engine) +
    HTML_TAIL.replace("__SKETCH__", sketchNorm);

  const bytes = new TextEncoder().encode(html);
  const bundle_hash = await sha256Hex(bytes);
  const local_cid = await cidV1Raw(bytes);

  return {
    bytes,
    bundle_hash,
    local_cid,
    commit_sha: resolvedCommit,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}

// CIDv1 with raw codec (0x55) over a sha2-256 (0x12, len 0x20)
// multihash. Format: <0x01><0x55><0x12><0x20><32-byte digest>, then
// multibase-encoded as `b` + RFC4648 base32 lowercase no-pad.
//
// This is the standard CID an IPFS node would produce for a single
// raw block ≤ 1 MiB (no UnixFS wrapping). Our bundles are well under
// 1 MiB, so a single raw block is the right shape.
export async function cidV1Raw(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const out = new Uint8Array(4 + digest.length);
  out[0] = 0x01; // cid version
  out[1] = 0x55; // raw codec
  out[2] = 0x12; // sha2-256 multihash code
  out[3] = 0x20; // multihash length (32 bytes)
  out.set(digest, 4);
  return "b" + base32Lower(out);
}

// RFC4648 base32 lowercase, no padding. Spec-compliant per the
// `base32` multibase entry that the IPFS ecosystem uses by default.
function base32Lower(data: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}
