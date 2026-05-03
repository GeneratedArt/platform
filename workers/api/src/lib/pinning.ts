// Dual-pin abstraction. `pinBundle()` fans out to web3.storage and
// Pinata. The result reports each provider's success independently
// and the resolved CID (the first provider to return one). When no
// provider returns a CID, `cid` is empty — the caller is responsible
// for translating that into a clean error rather than persisting a
// row whose CID resolves nowhere.
//
// Production deployments MUST set both `W3S_TOKEN` and `PINATA_JWT`
// via `wrangler secret put`. Dev / determinism tests opt into
// `PINNING_MOCK=1` to short-circuit the network calls.

import type { Env } from "../types";

export interface PinResult {
  /// Each provider's actual returned CID. These differ by
  /// construction — web3.storage and Pinata wrap UnixFS differently
  /// for single-file uploads — so we MUST track them separately
  /// rather than picking one as canonical and pretending both
  /// providers agreed on it.
  cid_w3s: string | null;
  cid_pinata: string | null;
  /// "Primary" CID for backwards-compat / the projects.frozen_cid
  /// mirror. First successful provider wins, w3s first.
  cid: string;
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  /// True when fewer than both providers succeeded (i.e. one or
  /// both failed / unconfigured). The caller decides whether a
  /// fully-failed pin should write a row or surface an error.
  partial: boolean;
  errors: Record<string, string>;
}

export interface PinInput {
  bytes: Uint8Array;
  filename: string;
}

function isMockPin(env: Env): boolean {
  return env.PINNING_MOCK === "1";
}

export async function pinBundle(
  env: Env,
  input: PinInput,
): Promise<PinResult> {
  if (isMockPin(env)) {
    // Mock mode CID is computed by the caller and substituted in.
    // We just report success against both providers without making
    // any network calls.
    return {
      cid: "",
      cid_w3s: null,
      cid_pinata: null,
      pinned_w3s: true,
      pinned_pinata: true,
      partial: false,
      errors: {},
    };
  }

  const errors: Record<string, string> = {};
  const [w3s, pin] = await Promise.allSettled([
    pinWeb3Storage(env, input),
    pinPinata(env, input),
  ]);

  let cidW3s: string | null = null;
  let cidPinata: string | null = null;
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

  const cid = cidW3s ?? cidPinata ?? "";
  const pinned_w3s = cidW3s !== null;
  const pinned_pinata = cidPinata !== null;
  const partial = !(pinned_w3s && pinned_pinata);
  return {
    cid,
    cid_w3s: cidW3s,
    cid_pinata: cidPinata,
    pinned_w3s,
    pinned_pinata,
    partial,
    errors,
  };
}

/// Re-pin existing bytes to a single named provider. Used by the
/// drift-recovery cron to top up a row after one provider drops the
/// pin while the other still serves it.
export async function repinTo(
  env: Env,
  provider: "w3s" | "pinata",
  input: PinInput,
): Promise<{ cid: string }> {
  if (isMockPin(env)) return { cid: "" };
  const cid =
    provider === "w3s"
      ? await pinWeb3Storage(env, input)
      : await pinPinata(env, input);
  return { cid };
}

async function pinWeb3Storage(
  env: Env,
  input: PinInput,
): Promise<string> {
  if (!env.W3S_TOKEN) throw new Error("w3s_unconfigured");
  // The legacy api.web3.storage Bearer-token upload endpoint accepts
  // a single file via multipart and is materially simpler to call
  // from a Worker than the new w3up UCAN flow. It is still
  // operational at time of writing; if it's deprecated we'll need to
  // swap to the w3up SDK.
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
  form.append("pinataMetadata", JSON.stringify({ name: input.filename }));
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
