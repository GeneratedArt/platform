// Task #15: dual-pin abstraction.
//
// `pin(blob)` fans out to web3.storage and Pinata. Either may be
// unconfigured (missing token); a pin is considered successful if at
// least one provider returns a CID. We always also compute a local
// CIDv1-raw of the bytes so the row carries a stable identifier even
// when both providers are unconfigured (mock-mode dev path), with
// pinning_partial=true to make that state obvious to the UI.
//
// Production deployments MUST set both `W3S_TOKEN` and `PINATA_JWT`
// via `wrangler secret put`. The Worker logs (via console.error) the
// per-provider failure reasons so wrangler tail surfaces them; we
// also persist them in `frozen_versions.pin_errors` for the UI.

import type { Env } from "../types";

export interface PinResult {
  /// CID we ultimately stored. Provider-returned when at least one
  /// succeeded; otherwise the local CIDv1-raw fallback.
  cid: string;
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  /// True when at least one provider was either unconfigured or
  /// failed. The freeze still returns success (provided we have *a*
  /// CID), but the row gets flagged so the UI can offer "retry".
  partial: boolean;
  errors: Record<string, string>;
}

export interface PinInput {
  bytes: Uint8Array;
  filename: string;
  /// Local fallback CID computed by the bundler, used when both
  /// providers are unconfigured / failed.
  fallbackCid: string;
}

function isMockPin(env: Env): boolean {
  // Mock mode: opt-in via PINNING_MOCK=1. In mock mode we synthesise
  // pin success without network calls; the local fallback CID is the
  // CID we report. Useful for dev / determinism tests where calling
  // the real services would either rate-limit or be undesirable.
  return env.PINNING_MOCK === "1";
}

export async function pinBundle(
  env: Env,
  input: PinInput,
): Promise<PinResult> {
  if (isMockPin(env)) {
    return {
      cid: input.fallbackCid,
      pinned_w3s: true,
      pinned_pinata: true,
      partial: false,
      errors: {},
    };
  }

  const errors: Record<string, string> = {};
  let cidW3s: string | null = null;
  let cidPinata: string | null = null;

  // Run providers in parallel. A slow provider should not delay the
  // other; a failed provider should not poison the result.
  const [w3s, pin] = await Promise.allSettled([
    pinWeb3Storage(env, input),
    pinPinata(env, input),
  ]);

  if (w3s.status === "fulfilled") {
    cidW3s = w3s.value;
  } else {
    errors.w3s = String((w3s as PromiseRejectedResult).reason ?? "unknown");
    console.error("pin_web3storage_failed", errors.w3s);
  }
  if (pin.status === "fulfilled") {
    cidPinata = pin.value;
  } else {
    errors.pinata = String((pin as PromiseRejectedResult).reason ?? "unknown");
    console.error("pin_pinata_failed", errors.pinata);
  }

  const cid = cidW3s ?? cidPinata ?? input.fallbackCid;
  const pinned_w3s = cidW3s !== null;
  const pinned_pinata = cidPinata !== null;
  const partial = !(pinned_w3s && pinned_pinata);

  return { cid, pinned_w3s, pinned_pinata, partial, errors };
}

async function pinWeb3Storage(
  env: Env,
  input: PinInput,
): Promise<string> {
  if (!env.W3S_TOKEN) throw new Error("w3s_unconfigured");
  // web3.storage's old "API token" upload endpoint accepts a single
  // file via multipart; the new w3up flow requires UCAN delegation
  // which is heavyweight inside a Worker. We use the legacy upload
  // endpoint here — it's still supported and matches the "single
  // file, single CID" mental model the rest of the pipeline assumes.
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.bytes], { type: "text/html" }),
    input.filename,
  );
  const res = await fetch("https://api.web3.storage/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.W3S_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`w3s_${res.status}:${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { cid?: string };
  if (!body.cid) throw new Error("w3s_no_cid_in_response");
  return body.cid;
}

async function pinPinata(env: Env, input: PinInput): Promise<string> {
  if (!env.PINATA_JWT) throw new Error("pinata_unconfigured");
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.bytes], { type: "text/html" }),
    input.filename,
  );
  // Tag with the filename so the Pinata dashboard shows something
  // useful; pinataMetadata is opt-in.
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: input.filename }),
  );
  const res = await fetch(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: form,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pinata_${res.status}:${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { IpfsHash?: string };
  if (!body.IpfsHash) throw new Error("pinata_no_cid_in_response");
  return body.IpfsHash;
}

/// Cron-side health check: is the CID still pinned by the providers
/// it was originally pinned by? Returns the providers that currently
/// confirm the pin. We deliberately don't trust gateway HTTP HEAD
/// (CDNs cache) — instead we hit each provider's pin-list endpoint.
export interface PinHealth {
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  errors: Record<string, string>;
}

export async function checkPinHealth(
  env: Env,
  cid: string,
): Promise<PinHealth> {
  if (isMockPin(env)) {
    return { pinned_w3s: true, pinned_pinata: true, errors: {} };
  }
  const errors: Record<string, string> = {};
  const [w3s, pin] = await Promise.allSettled([
    checkW3s(env, cid),
    checkPinata(env, cid),
  ]);
  let pinned_w3s = false;
  let pinned_pinata = false;
  if (w3s.status === "fulfilled") pinned_w3s = w3s.value;
  else errors.w3s = String((w3s as PromiseRejectedResult).reason);
  if (pin.status === "fulfilled") pinned_pinata = pin.value;
  else errors.pinata = String((pin as PromiseRejectedResult).reason);
  return { pinned_w3s, pinned_pinata, errors };
}

async function checkW3s(env: Env, cid: string): Promise<boolean> {
  if (!env.W3S_TOKEN) throw new Error("w3s_unconfigured");
  const res = await fetch(`https://api.web3.storage/status/${cid}`, {
    headers: { Authorization: `Bearer ${env.W3S_TOKEN}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`w3s_${res.status}`);
  return true;
}

async function checkPinata(env: Env, cid: string): Promise<boolean> {
  if (!env.PINATA_JWT) throw new Error("pinata_unconfigured");
  const res = await fetch(
    `https://api.pinata.cloud/data/pinList?hashContains=${cid}&status=pinned`,
    { headers: { Authorization: `Bearer ${env.PINATA_JWT}` } },
  );
  if (!res.ok) throw new Error(`pinata_${res.status}`);
  const body = (await res.json()) as { count?: number };
  return (body.count ?? 0) > 0;
}
