import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../lib/cookies";
import { verifySession } from "./jwt";
import type { Env, JwtPayload } from "../types";

export type AuthVariables = {
  user: JwtPayload;
};

export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const payload = await verifySession(c.env.JWT_SECRET, token);
  if (!payload) {
    return c.json({ error: "invalid_session" }, 401);
  }
  const revoked = await c.env.SESSIONS.get(`revoked:${payload.jti}`);
  if (revoked) {
    return c.json({ error: "session_revoked" }, 401);
  }
  c.set("user", payload);
  await next();
};

export function getAuthUser(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): JwtPayload {
  return c.get("user");
}
