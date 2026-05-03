// Per-minute uptime probe. Hits /health, /v1/me (expect 401), and
// an optional public project URL; pages Slack on failure with a
// per-URL 5-min mute via KV. No-op when UPTIME_PUBLIC_BASE is unset.

import type { Env } from "../types";

const MUTE_SECONDS = 5 * 60;
const PROBE_TIMEOUT_MS = 8000;

interface ProbeResult {
  url: string;
  expect: number | "any2xx";
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}

export async function runUptimeProbe(env: Env): Promise<ProbeResult[]> {
  const base = (env.UPTIME_PUBLIC_BASE ?? "").replace(/\/$/, "");
  if (!base) {
    console.log(JSON.stringify({ msg: "uptime_skip", reason: "no_base" }));
    return [];
  }

  const targets: Array<{ url: string; expect: number | "any2xx" }> = [
    { url: `${base}/health`, expect: "any2xx" },
    { url: `${base}/v1/me`, expect: 401 },
  ];
  if (env.UPTIME_PROJECT_PROBE_URL) {
    targets.push({ url: env.UPTIME_PROJECT_PROBE_URL, expect: "any2xx" });
  }

  const results: ProbeResult[] = [];
  for (const t of targets) {
    results.push(await probeOne(t.url, t.expect));
  }

  console.log(
    JSON.stringify({
      msg: "uptime",
      checked: results.length,
      failed: results.filter((r) => !r.ok).length,
      results,
    }),
  );

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) return results;

  // Per-URL mute. Slack is the single channel the task brief asks
  // for, and the mute is implemented in KV (RATE_LIMIT shares its
  // namespace with the Slack mute since both are short-TTL keys).
  for (const f of failures) {
    const muteKey = `uptime:mute:${await shortHash(f.url)}`;
    const muted = await env.RATE_LIMIT.get(muteKey);
    if (muted) {
      console.log(JSON.stringify({ msg: "uptime_muted", url: f.url }));
      continue;
    }
    await env.RATE_LIMIT.put(muteKey, "1", { expirationTtl: MUTE_SECONDS });
    await postSlack(env, f);
  }
  return results;
}

async function probeOne(
  url: string,
  expect: number | "any2xx",
): Promise<ProbeResult> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
    });
    const ms = Date.now() - t0;
    const ok =
      expect === "any2xx" ? res.status >= 200 && res.status < 300 : res.status === expect;
    return { url, expect, ok, status: res.status, ms, error: null };
  } catch (err) {
    return {
      url,
      expect,
      ok: false,
      status: null,
      ms: Date.now() - t0,
      error: (err as Error).message || "fetch_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postSlack(env: Env, f: ProbeResult): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  const text =
    `:rotating_light: *generatedart-api uptime alert*\n` +
    `URL: \`${f.url}\`\n` +
    `Expected: \`${f.expect}\`  ·  Got: \`${f.status ?? "no-response"}\`\n` +
    `Latency: ${f.ms}ms` +
    (f.error ? `\nError: \`${f.error}\`` : "") +
    `\nMuted for ${MUTE_SECONDS / 60} minutes.`;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn(`slack_post_failed: ${(err as Error).message}`);
  }
}

async function shortHash(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}
