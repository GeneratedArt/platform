// Per-request access middleware. Runs first in the chain so:
//   1. every response — including 4xx, errors, and 404s — carries an
//      x-request-id header,
//   2. every JSON error body is rewritten to include `request_id`
//      (centralized so individual handlers don't have to remember),
//   3. exceptions thrown from downstream are captured and surfaced
//      in the structured access log line alongside status/latency.
//
// The middleware itself never throws — all logging is best-effort.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { newRequestId, logAccess } from "../lib/log";
import { safeBumpRequest } from "../lib/metrics";

const REQUEST_ID_HEADER = "x-request-id";
const INBOUND_RE = /^[A-Za-z0-9._-]{8,64}$/;

export const accessMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const requestId = inbound && INBOUND_RE.test(inbound) ? inbound : newRequestId();
  c.set("requestId", requestId);
  c.header(REQUEST_ID_HEADER, requestId);

  const t0 = Date.now();
  let caught: unknown = null;
  try {
    await next();
  } catch (err) {
    // Capture for the access log; rethrow so app.onError still
    // produces the 500 response (which is what the user sees).
    caught = err;
    throw err;
  } finally {
    const latency_ms = Date.now() - t0;
    const route = c.req.routePath || c.req.path;
    // c.res may not exist if we're rethrowing; guard accordingly.
    const status = c.res ? c.res.status : 500;

    // Rewrite JSON error bodies to include request_id when missing.
    // Cheap to skip for non-JSON or 2xx responses.
    if (
      c.res &&
      status >= 400 &&
      (c.res.headers.get("content-type") ?? "").includes("application/json")
    ) {
      try {
        const cloned = c.res.clone();
        const body = await cloned.json<Record<string, unknown>>();
        if (body && typeof body === "object" && !("request_id" in body)) {
          const rebuilt = new Response(
            JSON.stringify({ ...body, request_id: requestId }),
            {
              status: c.res.status,
              statusText: c.res.statusText,
              headers: c.res.headers,
            },
          );
          c.res = rebuilt;
          c.header(REQUEST_ID_HEADER, requestId);
        }
      } catch {
        // body wasn't JSON object — leave it alone
      }
    }

    const errorChain =
      caught instanceof Error
        ? {
            message: caught.message,
            stack: caught.stack,
            cause:
              (caught as Error & { cause?: unknown }).cause instanceof Error
                ? (caught as Error & { cause?: Error }).cause!.message
                : undefined,
          }
        : caught
        ? { message: String(caught) }
        : null;

    try {
      logAccess({
        request_id: requestId,
        route,
        method: c.req.method,
        status,
        latency_ms,
        user_id: c.get("user")?.uid ?? null,
        ip: c.req.header("cf-connecting-ip") ?? null,
        error: errorChain,
      });
    } catch {
      // never let logging crash a response
    }

    if (!route.startsWith("/v1/internal/")) {
      // Tie the metric write to the request lifecycle so CF doesn't
      // cancel the D1 write once the response is flushed. Without
      // waitUntil, bursty traffic silently drops counter rows and
      // /v1/internal/stats under-reports.
      const p = safeBumpRequest(c.env, { route, status, latency_ms });
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        void p;
      }
    }
  }
};
