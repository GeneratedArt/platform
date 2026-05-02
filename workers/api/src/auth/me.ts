import type { Context } from "hono";
import type { Env } from "../types";
import { getAuthUser, type AuthVariables } from "./middleware";
import { getUserById } from "../db/users";
import { clearSessionCookie } from "../lib/cookies";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../lib/cookies";
import { verifySession } from "./jwt";

export async function meHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const user = await getUserById(c.env.DB, session.uid);
  if (!user) {
    return c.json({ error: "user_not_found" }, 404);
  }
  return c.json({
    user: {
      id: user.id,
      address: user.address,
      handle: user.handle,
      bio: user.bio,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
    },
    session: {
      jti: session.jti,
      exp: session.exp,
    },
  });
}

export async function logoutHandler(c: Context<{ Bindings: Env }>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const payload = await verifySession(c.env.JWT_SECRET, token);
    if (payload) {
      const ttl = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
      await c.env.SESSIONS.put(`revoked:${payload.jti}`, "1", {
        expirationTtl: ttl,
      });
    }
  }
  clearSessionCookie(c, c.env.COOKIE_DOMAIN);
  return c.json({ ok: true });
}
