// Task #20: Per-request access middleware.
//
// Sits at the very top of the Hono chain (before CORS) so the
// request_id is generated even for preflight OPTIONS — that way a
// 4xx on a preflight is still traceable. The middleware:
//   1. generates / accepts an x-request-id (clients may set their
//      own for end-to-end correlation),
//   2. exposes it via `c.set("requestId", id)` and the response
//      `x-request-id` header,
//   3. on response, emits one structured access log line and
//      best-effort bumps the per-route counter.
//
// We deliberately swallow exceptions inside this middleware — the
// global onError() handler is the single source of truth for 5xx
// responses, and a failure to log must never down the request.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { newRequestId, logAccess } from "../lib/log";
import { safeBumpRequest } from "../lib/metrics";

const REQUEST_ID_HEADER = "x-request-id";
// Accept inbound x-request-id only when it looks like a uuid-ish
// short string — guards against header injection in a log line.
const INBOUND_RE = /^[A-Za-z0-9._-]{8,64}$/;

export const accessMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const requestId =
    inbound && INBOUND_RE.test(inbound) ? inbound : newRequestId();
  c.set("requestId", requestId);
  c.header(REQUEST_ID_HEADER, requestId);

  const t0 = Date.now();
  try {
    await next();
  } finally {
    const latency_ms = Date.now() - t0;
    // routePath() is the matched template (e.g. "/v1/projects/:id/commit")
    // so it doesn't blow up the cardinality. Falls back to the raw
    // path for routes without a match (404 / OPTIONS).
    const route = c.req.routePath || c.req.path;
    const status = c.res.status;
    const session = c.get("user");
    const userId = session?.uid ?? null;
    let ip: string | null = null;
    const cf = c.req.header("cf-connecting-ip");
    if (cf) ip = cf;

    // Echo the request_id back to clients so a user-reported
    // screenshot can be cross-referenced with logs in one click.
    // Already set above; this is a no-op idempotent.
    c.header(REQUEST_ID_HEADER, requestId);

    try {
      logAccess({
        request_id: requestId,
        route,
        method: c.req.method,
        status,
        latency_ms,
        user_id: userId,
        ip,
      });
    } catch {
      // never let logging crash a response
    }

    // Skip metric bumps on the metric-read path itself so /v1/internal/stats
    // doesn't recursively inflate its own counters when polled.
    if (!route.startsWith("/v1/internal/")) {
      // Best effort; never await on the response thread.
      // We can't reliably reach ExecutionContext here, so fire and
      // forget. SQLite writes through D1 are queued internally.
      void safeBumpRequest(c.env, { route, status, latency_ms });
    }
  }
};
