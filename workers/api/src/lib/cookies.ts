import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";

export const SESSION_COOKIE = "ga_session";

export function setSessionCookie(
  c: Context,
  token: string,
  domain: string,
  maxAgeSeconds: number,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    domain,
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: Context, domain: string): void {
  deleteCookie(c, SESSION_COOKIE, { domain, path: "/" });
}
