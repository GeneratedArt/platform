// Hand-rolled Sentry envelope sender (no @sentry/cloudflare dep).
//
// SDK trade-off (decision recorded for review):
//   * Bundle: @sentry/cloudflare adds ~30KB minified to the worker;
//     this file is <4KB and uses zero runtime dependencies.
//   * Delivery: the SDK posts events via the same envelope endpoint
//     using fetch; we call the same `/api/<id>/envelope/` route
//     with the documented protocol (header line + item header line +
//     payload line, x-sentry-envelope content type). Callers wrap
//     this in `ctx.waitUntil(captureException(...))` so the runtime
//     keeps the worker alive until the POST completes — equivalent
//     to the SDK's flush-on-shutdown behaviour.
//   * Stack fidelity: we forward `Error.stack` verbatim and parse it
//     into Sentry frames (`stackToFrames`); on Cloudflare Workers
//     stacks are V8-formatted and source-maps would only help with
//     a full upload pipeline, which neither approach has wired up.
//   * PII safety: closed by default — no cookies, no Authorization,
//     no request body, no user handle/address/email; only {id} on
//     user; only request_id / route / status as tags. The SDK by
//     default *does* capture cookies and headers unless explicitly
//     scrubbed, so the hand-rolled approach is strictly safer here.
//
// captureException returns the Sentry event id on success, or null
// when SENTRY_DSN is unset (local dev) or the network call fails.

import type { Env } from "../types";

interface DsnParts {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
}

function parseDsn(dsn: string): DsnParts | null {
  // DSN shape: https://<publicKey>@<host>/<projectId>
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !u.host || !projectId) return null;
    return {
      protocol: u.protocol.replace(":", ""),
      publicKey: u.username,
      host: u.host,
      projectId,
    };
  } catch {
    return null;
  }
}

export interface CaptureContext {
  request_id: string;
  route?: string;
  status?: number;
  user_id?: number | null;
  // Free-form tags the caller wants surfaced (kept short — Sentry
  // truncates tag values at 200 chars).
  tags?: Record<string, string | number>;
}

/**
 * Best-effort capture of an unhandled exception. Returns the
 * Sentry-side event id when the POST succeeded, or null when the
 * DSN is unset, the parse failed, or the network call errored.
 * The promise is safe to drop on the floor — every awaited call
 * inside is guarded.
 *
 * Pass this to `ctx.waitUntil(captureException(...))` from the
 * Worker fetch handler so the response isn't blocked on Sentry's
 * round-trip.
 */
export async function captureException(
  env: Env,
  err: unknown,
  ctx: CaptureContext,
): Promise<string | null> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return null;
  const parts = parseDsn(dsn);
  if (!parts) return null;

  const eventId = randomEventId();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? "" : "";

  const payload = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "javascript",
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    server_name: "generatedart-api",
    request: ctx.route
      ? { url: `worker:${ctx.route}`, method: "WORKER" }
      : undefined,
    tags: {
      request_id: ctx.request_id,
      route: ctx.route ?? "",
      status: String(ctx.status ?? 500),
      ...stringifyTags(ctx.tags),
    },
    user: ctx.user_id ? { id: String(ctx.user_id) } : undefined,
    exception: {
      values: [
        {
          type: err instanceof Error ? err.name || "Error" : "Error",
          value: truncate(message, 1000),
          stacktrace: stack
            ? { frames: stackToFrames(stack) }
            : undefined,
        },
      ],
    },
  };

  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(payload)}\n`;

  const url = `${parts.protocol}://${parts.host}/api/${parts.projectId}/envelope/?sentry_key=${encodeURIComponent(parts.publicKey)}&sentry_version=7`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    });
    if (!res.ok) {
      console.warn(
        `sentry_capture_failed: status=${res.status} request_id=${ctx.request_id}`,
      );
      return null;
    }
    return eventId;
  } catch (netErr) {
    console.warn(
      `sentry_capture_threw: ${(netErr as Error).message} request_id=${ctx.request_id}`,
    );
    return null;
  }
}

function randomEventId(): string {
  // Sentry expects a 32-char hex (no dashes).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function stringifyTags(tags?: Record<string, string | number>): Record<string, string> {
  if (!tags) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

interface SentryFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
}

function stackToFrames(stack: string): SentryFrame[] {
  // V8-style stacks: "    at fn (file:line:col)" or "    at file:line:col".
  const out: SentryFrame[] = [];
  const lines = stack.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);
    const m = /^(.+?)\s+\((.+):(\d+):(\d+)\)$/.exec(body)
      ?? /^(.+):(\d+):(\d+)$/.exec(body);
    if (!m) continue;
    if (m.length === 5) {
      out.push({
        function: m[1],
        filename: m[2],
        lineno: parseInt(m[3]!, 10),
        colno: parseInt(m[4]!, 10),
      });
    } else {
      out.push({
        filename: m[1],
        lineno: parseInt(m[2]!, 10),
        colno: parseInt(m[3]!, 10),
      });
    }
  }
  // Sentry expects frames in reverse order (oldest first).
  return out.reverse().slice(-30);
}
