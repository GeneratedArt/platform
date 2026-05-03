// Task #20: Structured logging + request_id helper.
//
// Every Worker request emits exactly one JSON access-log line via
// `logAccess()` once the response is finalised. Errors call
// `logError()` (which is also picked up by Cloudflare's log view).
// We deliberately use plain `console.log/error` rather than a fancy
// transport — Cloudflare's runtime captures stdout/stderr and the
// dashboard already pretty-prints JSON.
//
// `request_id` is a short UUID-ish string generated per request and
// attached to:
//   1. the structured log line,
//   2. the error response body (so a user-reported screenshot is
//      one click away from the stack trace),
//   3. the `x-request-id` response header,
//   4. the Sentry tag on captureException() (see lib/sentry.ts).

export type LogLevel = "info" | "warn" | "error";

export interface AccessLogFields {
  request_id: string;
  route: string;
  method: string;
  status: number;
  latency_ms: number;
  user_id?: number | null;
  ip?: string | null;
  // Optional error chain for the line that records a 5xx. Strings
  // only — Worker structured logs can't carry deep object trees
  // reliably without exploding the line size.
  error?: { message: string; stack?: string; cause?: string } | null;
  // Sub-route hint: stats endpoint sets this so we can break down
  // by request kind in /v1/internal/stats.
  meta?: Record<string, unknown>;
}

export function newRequestId(): string {
  // crypto.randomUUID is available in the Cloudflare runtime; fall
  // back to a slow path for the unlikely case it isn't.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let s = "";
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function logAccess(fields: AccessLogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level: (fields.status >= 500 ? "error" : fields.status >= 400 ? "warn" : "info") as LogLevel,
    msg: "access",
    ...fields,
  };
  if (line.level === "error") {
    console.error(JSON.stringify(line));
  } else if (line.level === "warn") {
    console.warn(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export function logError(
  request_id: string,
  msg: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const e =
    err instanceof Error
      ? { message: err.message, stack: err.stack, cause: errCause(err) }
      : { message: String(err) };
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error" as LogLevel,
      msg,
      request_id,
      error: e,
      ...(extra ?? {}),
    }),
  );
}

function errCause(err: Error): string | undefined {
  const c = (err as Error & { cause?: unknown }).cause;
  if (!c) return undefined;
  if (c instanceof Error) return c.message;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}
