// Structured access logging + request_id helpers.
// One JSON line per request via logAccess(); ad-hoc errors via logError().

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
