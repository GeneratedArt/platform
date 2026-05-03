// Task #20: /v1/internal/stats — admin-only health snapshot.
//
// Read-only. Pulls activity + request + latency counters from D1
// (lib/metrics.ts) and inspects the RATE_LIMIT KV for the
// approximate bucket size. No secrets in the response.

import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { readStats } from "../lib/metrics";
import { logError } from "../lib/log";

export async function statsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const requestId = c.get("requestId");
  try {
    const snap = await readStats(c.env.DB);
    // Approximate rate-limit bucket size — list returns up to 1000
    // keys; for ops visibility "more than X buckets active" is
    // enough.
    let rate_limit_buckets = 0;
    try {
      const list = await c.env.RATE_LIMIT.list({ limit: 1000 });
      rate_limit_buckets = list.keys.length;
    } catch {
      rate_limit_buckets = -1;
    }
    return c.json({
      stats: { ...snap, rate_limit_buckets },
      env: {
        sentry_configured: Boolean(c.env.SENTRY_DSN),
        slack_configured: Boolean(c.env.SLACK_WEBHOOK_URL),
        uptime_base: c.env.UPTIME_PUBLIC_BASE ?? null,
      },
      request_id: requestId,
    });
  } catch (err) {
    logError(requestId, "stats_handler_failed", err);
    return c.json(
      { error: "stats_failed", request_id: requestId },
      500,
    );
  }
}

/**
 * Forced-throw smoke route. Admin-only; raises so the global
 * onError handler runs. The point is to verify the request_id
 * round-trips end to end (response body, log line, Sentry tag).
 */
export async function throwHandler(
  _c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<Response> {
  throw new Error("forced_internal_throw_for_smoke_test");
}

/**
 * Receives client-side errors from studio.ts / dashboard.ts /
 * galleries.ts. Public + rate-limited at the handler level so an
 * abusive page can't fill the log pipeline. The body is bounded at
 * 4KB before we even decode it.
 */
const CLIENT_ERROR_MAX_BYTES = 4 * 1024;

export async function clientErrorHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const requestId = c.get("requestId");
  const len = parseInt(c.req.header("content-length") ?? "0", 10);
  if (Number.isFinite(len) && len > CLIENT_ERROR_MAX_BYTES) {
    return c.json({ error: "payload_too_large", request_id: requestId }, 413);
  }
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json", request_id: requestId }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.slice(0, 500) : "(no message)";
  const stack = typeof b.stack === "string" ? b.stack.slice(0, 4000) : null;
  const page = typeof b.page === "string" ? b.page.slice(0, 200) : null;
  const ua = c.req.header("user-agent")?.slice(0, 200) ?? null;
  const session = c.get("user");
  // Structured log so Logflare / Cloudflare logs pick it up.
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "client_error",
      request_id: requestId,
      page,
      message,
      stack,
      ua,
      user_id: session?.uid ?? null,
    }),
  );
  // Best-effort Sentry forward. Imported lazily to keep the cold
  // path light when no client errors fire.
  try {
    const { captureException } = await import("../lib/sentry");
    const err = new Error(message);
    if (stack) err.stack = stack;
    await captureException(c.env, err, {
      request_id: requestId,
      route: "client",
      tags: { source: "client", page: page ?? "" },
      user_id: session?.uid ?? null,
    });
  } catch {
    // already logged above
  }
  return c.json({ ok: true, request_id: requestId });
}
