// Window onerror / unhandledrejection → POST /v1/internal/client-error.
// Per-page de-dupe and 10-report cap; the Worker rate-limits per IP
// and forwards to Sentry via SENTRY_DSN_PUBLIC server-side.
//
// Why not @sentry/browser? Bundle size is the deciding factor:
// @sentry/browser min+gz is ~25KB, which is larger than every
// per-page bundle this app ships (galleries 18KB, studio 100KB,
// dashboard 7KB). The proxy pattern below has equivalent delivery
// (the worker uses ctx.waitUntil for the forward), preserves stack
// fidelity (we POST the raw `Error.stack` string verbatim), and
// keeps the public DSN out of the client where it would otherwise
// be visible to scrapers. The trade-off is that we don't get the
// SDK's auto-capture of breadcrumbs / fetch/console hooks; for v1
// observability that's an acceptable gap given the size budget.

const SEEN = new Set<string>();
const MAX_REPORTS_PER_PAGE = 10;
let installed = false;
let configured: { apiBase: string; page: string } | null = null;

export interface ClientErrorReporterConfig {
  apiBase: string;
  /** Short page identifier — "studio", "dashboard", "galleries" etc. */
  page: string;
}

export function installClientErrorReporter(cfg: ClientErrorReporterConfig): void {
  if (installed) return;
  installed = true;
  configured = cfg;
  window.addEventListener("error", (ev) => {
    const message =
      (ev.error && ev.error.message) || ev.message || "unknown_error";
    const stack =
      (ev.error && ev.error.stack) ||
      `${ev.filename ?? ""}:${ev.lineno ?? 0}:${ev.colno ?? 0}`;
    void report(message, stack);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
        ? reason
        : "unhandled_rejection";
    const stack = reason instanceof Error ? reason.stack ?? "" : "";
    void report(message, stack);
  });
}

// PII scrub: strip query string and hash from any URL we forward
// so signed-upload tokens, ?email=, ?invite=, fragment-encoded
// session bits, etc. never leave the browser. Also caps length.
function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw, location.origin);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return raw.split("?")[0].split("#")[0].slice(0, 200);
  }
}

async function report(message: string, stack: string): Promise<void> {
  if (!configured) return;
  // Per-page de-dupe + cap so a hot-loop error doesn't DoS the
  // /v1/internal/client-error endpoint.
  if (SEEN.size >= MAX_REPORTS_PER_PAGE) return;
  const key = `${message}::${stack.slice(0, 80)}`;
  if (SEEN.has(key)) return;
  SEEN.add(key);

  try {
    await fetch(`${configured.apiBase}/v1/internal/client-error`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        stack: String(stack).slice(0, 4000),
        page: configured.page,
        url: scrubUrl(location.href),
        ts: Date.now(),
      }),
      keepalive: true,
    });
  } catch {
    // never escalate a reporter failure into another error event
  }
}
