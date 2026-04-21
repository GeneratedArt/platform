#!/usr/bin/env node
/**
 * Static bundle checks. Reads validate.config.json and fails if:
 *   - the zipped bundle would exceed max_zip_bytes
 *   - any required_files are missing
 *   - any forbidden_patterns appear in shipped JS/HTML
 *   - any <script src> points outside the repo
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const cfg = JSON.parse(fs.readFileSync("validate.config.json", "utf8"));
const root = process.cwd();

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist")
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(root);

for (const req of cfg.required_files) {
  if (!fs.existsSync(path.join(root, req))) {
    fail(`required file missing: ${req}`);
  }
}

const text = files
  .filter((f) => /\.(js|mjs|html)$/.test(f))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");

for (const pattern of cfg.forbidden_patterns) {
  const re = new RegExp(pattern);
  if (re.test(text)) fail(`forbidden pattern matched: /${pattern}/`);
}

const remoteScript = /<script\s+[^>]*src=["']https?:\/\//i;
for (const f of files.filter((f) => f.endsWith(".html"))) {
  if (remoteScript.test(fs.readFileSync(f, "utf8"))) {
    fail(`remote <script src> in ${f} — vendor the library locally instead`);
  }
}

// Crude library detection: if a vendored script's filename does not start with
// any allowlisted name, fail.
const vendorDir = path.join(root, "vendor");
if (fs.existsSync(vendorDir)) {
  for (const v of fs.readdirSync(vendorDir)) {
    if (!cfg.library_allowlist.some((lib) => v.toLowerCase().startsWith(lib))) {
      fail(`vendor/${v} is not in the library allowlist`);
    }
  }
}

// Size: zip the candidate bundle and measure.
fs.mkdirSync(".validate-out", { recursive: true });
execSync(
  `zip -qr .validate-out/bundle.zip index.html src vendor LICENSE README.md -x "*.git*" "node_modules/*" ".github/*"`,
  { stdio: "inherit" }
);
const size = fs.statSync(".validate-out/bundle.zip").size;
if (size > cfg.max_zip_bytes) {
  fail(`bundle size ${size}B exceeds limit ${cfg.max_zip_bytes}B`);
}

console.log(`ok: ${files.length} files, zip ${size}B`);

function fail(msg) {
  console.error("VALIDATION FAILED:", msg);
  process.exit(1);
}
