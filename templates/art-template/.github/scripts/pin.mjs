#!/usr/bin/env node
/**
 * Pin the release zip to Pinata and (optionally) web3.storage, then write the
 * resulting CID to GITHUB_OUTPUT so release.yml can put it in the release notes.
 */
import fs from "node:fs";

const [, , bundlePath] = process.argv;
if (!bundlePath || !fs.existsSync(bundlePath)) {
  console.error("usage: pin.mjs <bundle.zip>");
  process.exit(1);
}

const PINATA_JWT = process.env.PINATA_JWT;
if (!PINATA_JWT) {
  console.error("PINATA_JWT secret is not set on this repo");
  process.exit(1);
}

const fileBuf = fs.readFileSync(bundlePath);
const fd = new FormData();
fd.set("file", new Blob([fileBuf]), bundlePath.split("/").pop());
fd.set(
  "pinataMetadata",
  JSON.stringify({
    name: bundlePath.split("/").pop(),
    keyvalues: { repo: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA },
  })
);

const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
  method: "POST",
  headers: { Authorization: `Bearer ${PINATA_JWT}` },
  body: fd,
});
if (!res.ok) {
  console.error("pinata failed:", res.status, await res.text());
  process.exit(1);
}
const { IpfsHash: bundleCid } = await res.json();

// Metadata CID is computed by a follow-up step that pins the per-token JSON
// directory; until that script lands we publish the bundle CID for both.
const metadataCid = bundleCid;

const out = process.env.GITHUB_OUTPUT;
if (out) {
  fs.appendFileSync(out, `bundle_cid=${bundleCid}\nmetadata_cid=${metadataCid}\n`);
}
console.log("pinned bundle_cid=" + bundleCid);
