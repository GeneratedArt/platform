// Frozen bundler.
//
// Produces a self-contained HTML bundle for a project at a specific
// commit. Determinism contract: identical {repo tree at ref,
// vendored runtime versions, project metadata} → byte-identical
// output. The recorded `bundle_hash` is the SHA-256 of a canonical
// manifest (sorted "[path]\t[sha256]\n" lines), which matches the
// spec's "sorted-tarball" hash and is independent of any incidental
// HTML formatting drift.

import type { Env } from "../types";
import { listRepoTreeAtRef, getRepoFile } from "./github";
import P5_SOURCE from "../../vendor/p5.min.js";
import THREE_SOURCE from "../../vendor/three.min.js";

export interface BundleResult {
  /// Canonical bytes that get pinned.
  bytes: Uint8Array;
  /// SHA-256 of the canonical manifest (sorted `path\tsha256\n` lines).
  /// Stored as `frozen_versions.bundle_hash`.
  bundle_hash: string;
  /// CIDv1 (raw codec) computed locally from `bytes`. Pinning
  /// providers may return a different CID (UnixFS-wrapped); use the
  /// provider CID when available, fall back to this otherwise.
  local_cid: string;
  /// Echo of the source commit/ref the bundle was built from.
  commit_sha: string;
  /// Sorted manifest of every input that contributed to the hash.
  manifest: ManifestEntry[];
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface FreezeInput {
  repoFull: string | null;
  engine: string;
  title: string;
  /// Commit SHA, branch, or "latest". When set to a SHA, the resolved
  /// tree pins to exactly that commit; "latest" resolves to whatever
  /// the default branch's HEAD is at request time.
  commit: string;
  projectId: number;
}

export interface FreezeRuntime {
  p5: string;
  three: string;
}

const DEFAULT_RUNTIME: FreezeRuntime = {
  p5: P5_SOURCE,
  three: THREE_SOURCE,
};

// Files we never include in the frozen bundle. The bundle is meant
// to be the runtime view of the artwork — package manifests,
// lockfiles, type configs, CI files, the README, and so on are not
// part of "what executes at mint time" and would just inflate the
// CID. Editor metadata (.vscode, .idea) similarly excluded.
const DEV_DIR_RE = /^(\.git|\.github|\.vscode|\.idea|node_modules|dist|build)(\/|$)/;
const DEV_FILE_RE =
  /^(package(-lock)?\.json|tsconfig.*|README.*|\.gitignore|\.editorconfig|\.prettier.*|\.eslint.*|LICENSE.*|CHANGELOG.*)$/i;
const ALLOWED_TOP_LEVEL = new Set(["sketch.js", "assets"]);

function isDevPath(path: string): boolean {
  if (DEV_DIR_RE.test(path)) return true;
  const top = path.split("/")[0];
  if (DEV_FILE_RE.test(top)) return true;
  // Tolerate other top-level files but require either sketch.js at
  // root OR the assets/ tree. Anything else (.env, etc.) is dev-only.
  if (!ALLOWED_TOP_LEVEL.has(top)) return true;
  return false;
}

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap on output

/// Build a deterministic, self-contained HTML bundle.
export async function buildBundle(
  env: Env,
  input: FreezeInput,
  runtime: FreezeRuntime = DEFAULT_RUNTIME,
): Promise<BundleResult> {
  let resolvedCommit = input.commit;

  // Pull the file list at the requested ref. Without a real repo we
  // fall back to a tiny synthetic tree so dev seeds still freeze.
  let entries: { path: string; bytes: Uint8Array }[];
  if (!input.repoFull) {
    entries = [
      {
        path: "sketch.js",
        bytes: new TextEncoder().encode(
          `// project ${input.projectId}: no source available`,
        ),
      },
    ];
    resolvedCommit = "no-source";
  } else {
    const ref =
      !input.commit || input.commit === "latest" ? undefined : input.commit;
    const tree = await listRepoTreeAtRef(env, input.repoFull, ref);
    // Fetch every non-dev file's content. Sequential is intentional —
    // GitHub's secondary rate limit is sensitive to bursty parallel
    // reads from a single PAT, and a typical sketch repo is < 20
    // files anyway.
    entries = [];
    for (const node of tree.files) {
      if (node.type !== "blob") continue;
      if (isDevPath(node.path)) continue;
      const file = await getRepoFile(env, input.repoFull, node.path, ref);
      // Normalise text line endings so a Windows-authored file
      // doesn't produce a different hash than an identical Unix one.
      // Binary files (assets) are passed through untouched.
      const isText = /\.(js|json|css|html|svg|txt|md)$/i.test(node.path);
      const raw = isText
        ? file.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        : file.content;
      entries.push({
        path: node.path,
        bytes: new TextEncoder().encode(raw),
      });
    }
    if (input.commit && input.commit !== "latest") {
      resolvedCommit = input.commit;
    } else {
      resolvedCommit = tree.headSha ?? "no-source";
    }
  }

  // Canonical sort: ascending by path. The manifest hash depends on
  // this order; the inlined HTML embeds the same order so both views
  // agree.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Pick the runtime source up front so it can flow into the
  // manifest as a virtual `__meta__/runtime` entry. Bundling against
  // a different p5/three version MUST change `bundle_hash` even if
  // every other input is identical.
  let runtimeSource = "";
  if (input.engine === "p5") runtimeSource = runtime.p5;
  else if (input.engine === "three") runtimeSource = runtime.three;

  // Build the manifest (path → sha256 of bytes). This is the
  // sorted-tarball-equivalent the spec asks for: stable, content-
  // addressed, immune to incidental HTML formatting differences.
  // We include synthetic `__meta__/*` entries for inputs that
  // aren't files but DO change the output (title, engine, runtime
  // version, project id, resolved commit) so the manifest hash is
  // a complete fingerprint of every input that contributed to the
  // bundle.
  const manifest: ManifestEntry[] = [];
  for (const e of entries) {
    manifest.push({
      path: e.path,
      sha256: await sha256Hex(e.bytes),
      size: e.bytes.length,
    });
  }
  const meta: Array<[string, string]> = [
    ["__meta__/title", input.title],
    ["__meta__/engine", input.engine],
    ["__meta__/project_id", String(input.projectId)],
    ["__meta__/commit", resolvedCommit],
    ["__meta__/runtime", runtimeSource],
  ];
  for (const [path, value] of meta) {
    const bytes = new TextEncoder().encode(value);
    manifest.push({
      path,
      sha256: await sha256Hex(bytes),
      size: bytes.length,
    });
  }
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestText = manifest.map((m) => `${m.path}\t${m.sha256}\n`).join("");
  const bundle_hash = await sha256Hex(new TextEncoder().encode(manifestText));

  // Build the inlined HTML. The runtime is inlined as a `<script>`
  // block (escaped against `</script>` breakout); the sketch source
  // and any assets are embedded next so the resulting page is fully
  // self-contained and can render from `ipfs://{cid}/?seed=…`.
  const sketchEntry = entries.find((e) => e.path === "sketch.js");
  const sketchSource = sketchEntry
    ? new TextDecoder().decode(sketchEntry.bytes)
    : `console.warn("no sketch.js");`;
  const assetMap: Record<string, string> = {};
  for (const e of entries) {
    if (e.path === "sketch.js") continue;
    assetMap[e.path] = bytesToDataUri(e.path, e.bytes);
  }

  const html = renderHtml({
    title: input.title,
    runtimeSource,
    sketchSource,
    assetMap,
    manifest,
    commit: resolvedCommit,
    bundleHash: bundle_hash,
  });
  const bytes = new TextEncoder().encode(html);
  if (bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `bundle_too_large:${bytes.length}>${MAX_BUNDLE_BYTES}`,
    );
  }
  const local_cid = await cidV1Raw(bytes);
  return { bytes, bundle_hash, local_cid, commit_sha: resolvedCommit, manifest };
}

interface RenderInput {
  title: string;
  runtimeSource: string;
  sketchSource: string;
  assetMap: Record<string, string>;
  manifest: ManifestEntry[];
  commit: string;
  bundleHash: string;
}

function renderHtml(r: RenderInput): string {
  // Defensive escapes:
  //  - Page title goes into <title> via HTML escape.
  //  - Runtime + sketch sources go into `<script>` blocks; the only
  //    way to break out of a `<script>` is the literal "</script>"
  //    sequence, which we escape by inserting a backslash before the
  //    slash. Browsers parse "<\/script>" inside a JS string as a
  //    "</script>" token only after JS lex, never inside HTML lex.
  const safeTitle = htmlEscape(r.title);
  const safeRuntime = scriptEscape(r.runtimeSource);
  const safeSketch = scriptEscape(r.sketchSource);
  // assetMap is JSON-encoded; JSON.stringify already escapes "</" but
  // we belt-and-braces against `</script>` regardless.
  const assetJson = scriptEscape(JSON.stringify(r.assetMap));
  const manifestJson = scriptEscape(
    JSON.stringify({
      commit: r.commit,
      bundle_hash: r.bundleHash,
      files: r.manifest,
    }),
  );
  return `<!doctype html>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>html,body{margin:0;padding:0;background:#0b0b0b;color:#eee;font-family:system-ui;overflow:hidden}canvas{display:block;margin:0 auto}</style>
<script id="ga-manifest" type="application/json">${manifestJson}</script>
<script id="ga-assets" type="application/json">${assetJson}</script>
<script>
(function(){
  var p=new URLSearchParams(location.search);
  window.GA_SEED=p.get("seed")||"0";
  window.GA_TOKEN_ID=p.get("tokenId")||"0";
  try{window.GA_ASSETS=JSON.parse(document.getElementById("ga-assets").textContent||"{}");}
  catch(e){window.GA_ASSETS={};}
})();
</script>
<script>${safeRuntime}</script>
<script id="ga-sketch">${safeSketch}</script>
`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scriptEscape(s: string): string {
  // Prevent `</script>` (and `<!--` / `-->` HTML comment tokens that
  // some browsers reinterpret inside <script> in quirks mode) from
  // breaking out of the surrounding <script> element.
  return s
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--")
    .replace(/-->/g, "--\\>");
}

function bytesToDataUri(path: string, bytes: Uint8Array): string {
  const mime = mimeFor(path);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

function mimeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "json": return "application/json";
    case "txt": case "md": return "text/plain";
    case "css": return "text/css";
    case "js": return "text/javascript";
    case "wasm": return "application/wasm";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    default: return "application/octet-stream";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}

export async function cidV1Raw(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const out = new Uint8Array(4 + digest.length);
  out[0] = 0x01;
  out[1] = 0x55;
  out[2] = 0x12;
  out[3] = 0x20;
  out.set(digest, 4);
  return "b" + base32Lower(out);
}

function base32Lower(data: Uint8Array): string {
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
