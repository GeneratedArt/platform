/**
 * Session helpers — wraps /me with a tiny in-memory cache so multiple islands
 * on the same page don't fan out duplicate requests.
 */
import { apiFetch, getToken, setToken } from "./api";

export type Me = {
  id: string;
  github_login?: string | null;
  wallet_address?: string | null;
  role: "collector" | "artist" | "gallery" | "curator" | "steward";
  display_name?: string | null;
  avatar_url?: string | null;
};

let cache: { promise?: Promise<Me | null>; value?: Me | null } = {};

export function getCachedMe(): Me | null | undefined {
  return cache.value;
}

export async function loadMe(force = false): Promise<Me | null> {
  if (!force && cache.value !== undefined) return cache.value!;
  if (!force && cache.promise) return cache.promise;
  if (!getToken()) { cache.value = null; return null; }
  cache.promise = (async () => {
    try {
      const r = await apiFetch<{ user: Me }>("/me", { auth: true });
      cache.value = r.user;
      return r.user;
    } catch (e: any) {
      if (e.status === 401) { setToken(null); cache.value = null; return null; }
      throw e;
    } finally {
      cache.promise = undefined;
    }
  })();
  return cache.promise;
}

export function clearSession() {
  setToken(null);
  cache = { value: null };
}

export function startGithubLogin(redirectAfter?: string) {
  const clientId = (import.meta as any).env?.PUBLIC_GITHUB_CLIENT_ID;
  if (!clientId) {
    alert("GitHub sign-in isn't configured for this environment yet.");
    return;
  }
  const state = crypto.randomUUID();
  try { sessionStorage.setItem("ga.oauth_state", state); } catch {}
  if (redirectAfter) {
    try { sessionStorage.setItem("ga.oauth_return", redirectAfter); } catch {}
  }
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", `${location.origin}/auth/callback`);
  location.href = u.toString();
}
