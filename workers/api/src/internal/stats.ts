// /v1/internal/stats — admin-only health snapshot.
// /v1/internal/_throw — admin-only forced 500 to verify request_id.
// /v1/internal/client-error — public, IP rate-limited client error sink.

import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { readStats } from "../lib/metrics";
import { logError } from "../lib/log";
import { captureException } from "../lib/sentry";

export async function statsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const requestId = c.get("requestId");
  try {
    const snap = await readStats(c.env.DB);
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
        sentry_public_configured: Boolean(c.env.SENTRY_DSN_PUBLIC),
        slack_configured: Boolean(c.env.SLACK_WEBHOOK_URL),
        uptime_base: c.env.UPTIME_PUBLIC_BASE ?? null,
      },
      request_id: requestId,
    });
  } catch (err) {
    logError(requestId, "stats_handler_failed", err);
    return c.json({ error: "stats_failed", request_id: requestId }, 500);
  }
}

export async function throwHandler(
  _c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<Response> {
  throw new Error("forced_internal_throw_for_smoke_test");
}

const CLIENT_ERROR_MAX_BYTES = 4 * 1024;
const CLIENT_ERROR_LIMIT_PER_MIN = 30;

export async function clientErrorHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const requestId = c.get("requestId");

  // Per-IP rate limit: 30 reports / minute. Prevents an abusive page
  // from filling the log pipeline or burning Sentry quota.
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const rlKey = `cerr:${minute}:${ip}`;
  try {
    const cur = await c.env.RATE_LIMIT.get(rlKey);
    const n = cur ? parseInt(cur, 10) : 0;
    if (n >= CLIENT_ERROR_LIMIT_PER_MIN) {
      return c.json({ error: "rate_limited", request_id: requestId }, 429);
    }
    await c.env.RATE_LIMIT.put(rlKey, String(n + 1), { expirationTtl: 90 });
  } catch {
    // KV outage — fail open rather than block error reporting
  }

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

  // Forward to a *separate* Sentry project via SENTRY_DSN_PUBLIC so
  // browser-side noise has its own quota / sampling and doesn't
  // crowd out worker exceptions on SENTRY_DSN. ctx.waitUntil keeps
  // the runtime alive until the envelope POST completes.
  if (c.env.SENTRY_DSN_PUBLIC) {
    const err = new Error(message);
    if (stack) err.stack = stack;
    const p = captureException(
      { ...c.env, SENTRY_DSN: c.env.SENTRY_DSN_PUBLIC } as Env,
      err,
      {
        request_id: requestId,
        route: "client",
        tags: { source: "client", page: page ?? "" },
        user_id: session?.uid ?? null,
      },
    ).catch(() => null);
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p;
    }
  }
  return c.json({ ok: true, request_id: requestId });
}
