// Window onerror / unhandledrejection → POST /v1/internal/client-error.
// Per-page de-dupe and 10-report cap; the Worker rate-limits per IP.

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
        url: location.href.slice(0, 200),
        ts: Date.now(),
      }),
      keepalive: true,
    });
  } catch {
    // never escalate a reporter failure into another error event
  }
}
