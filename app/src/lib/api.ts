/**
 * Tiny browser API client for api.generatedart.com. Reads the bearer token
 * from localStorage (`ga.session_token`) — same key the Jekyll site uses.
 *
 * Server-side rendering (Astro pages) calls `apiFetch` with no token; for
 * authenticated requests prefer rendering a placeholder shell and letting
 * client islands hydrate the data so we never leak tokens via SSR.
 */
export const API_BASE: string =
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — astro injects PUBLIC_* into import.meta.env at build time
  (import.meta as any).env?.PUBLIC_API_BASE ?? "https://api.generatedart.com";
export const RENDERER_BASE: string =
  // @ts-ignore
  (import.meta as any).env?.PUBLIC_RENDERER_BASE ?? "https://renderer.generatedart.com";
export const SITE_BASE: string =
  // @ts-ignore
  (import.meta as any).env?.PUBLIC_SITE_BASE ?? "https://generatedart.com";
export const CHAIN_ID: number = Number(
  // @ts-ignore
  (import.meta as any).env?.PUBLIC_CHAIN_ID ?? 84532
);

const TOKEN_KEY = "ga.session_token";

export function getToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  if (typeof localStorage === "undefined") return;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

export type ApiOpts = RequestInit & { auth?: boolean };

export async function apiFetch<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (!headers.has("Content-Type") && opts.body && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const tok = opts.auth !== false ? getToken() : null;
  if (tok) headers.set("Authorization", `Bearer ${tok}`);
  const res = await fetch(API_BASE + path, { ...opts, headers });
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch {}
    const err: any = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
