#!/usr/bin/env node
/**
 * Deterministic render check.
 *
 * Boots the bundle in headless Chromium twice with the same hash and pixel-
 * diffs the captured frame. Any non-zero diff fails the PR.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const cfg = JSON.parse(fs.readFileSync("validate.config.json", "utf8"));
const [W, H] = cfg.deterministic_render.viewport;
const FRAMES = cfg.deterministic_render.frames_to_skip ?? 60;
const TOL = cfg.deterministic_render.tolerance_pixels ?? 0;
const TEST_HASH =
  "0xdeadbeefcafebabefeedfacedeadbeefcafebabefeedfacedeadbeefcafebabe";

fs.mkdirSync(".validate-out", { recursive: true });

const browser = await chromium.launch();
try {
  const buf1 = await capture();
  const buf2 = await capture();
  fs.writeFileSync(".validate-out/run-1.png", buf1);
  fs.writeFileSync(".validate-out/run-2.png", buf2);

  if (buf1.length !== buf2.length) {
    fail(`png byte length differs: ${buf1.length} vs ${buf2.length}`);
  }
  let diff = 0;
  for (let i = 0; i < buf1.length; i++) if (buf1[i] !== buf2[i]) diff++;
  if (diff > TOL) {
    fail(`pixel diff ${diff} bytes > tolerance ${TOL}`);
  }
  console.log(`deterministic ok (diff=${diff})`);
} finally {
  await browser.close();
}

async function capture() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  // Hard-block any outbound network call. Local file:// only.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("file://")) return route.continue();
    return route.abort("blockedbyclient");
  });
  await page.goto(
    "file://" +
      path.resolve("index.html") +
      `?hash=${TEST_HASH}&token=0&preview=1`
  );
  for (let i = 0; i < FRAMES; i++) await page.waitForTimeout(16);
  const buf = await page.screenshot({ type: "png" });
  await ctx.close();
  return buf;
}

function fail(msg) {
  console.error("VALIDATION FAILED:", msg);
  process.exit(1);
}
