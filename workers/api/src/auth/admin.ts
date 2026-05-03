// Env-var-gated admin middleware. Closed-by-default: when
// ADMIN_HANDLES is unset or empty the route 403s admin_unconfigured.
// Runs after requireAuth so c.get("user") is populated.

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getAuthUser, type AuthVariables } from "./middleware";
import { getUserById } from "../db/users";

export const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const session = getAuthUser(c);
  const allow = parseAllowlist(c.env.ADMIN_HANDLES);
  if (allow.length === 0) {
    // Closed by default — better to 403 than to ship an open
    // /v1/internal/* surface because someone forgot to set the var.
    return c.json({ error: "admin_unconfigured" }, 403);
  }
  const user = await getUserById(c.env.DB, session.uid);
  if (!user) return c.json({ error: "user_not_found" }, 404);
  if (!allow.includes(user.handle.toLowerCase())) {
    return c.json({ error: "not_admin" }, 403);
  }
  await next();
};

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9-]{1,30}$/.test(s));
}

export function isAdminContext(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): boolean {
  // Cheap check used by the access-log middleware so admin probe
  // traffic doesn't pollute /v1/internal/stats with its own probes.
  const session = c.get("user");
  if (!session) return false;
  const allow = parseAllowlist(c.env.ADMIN_HANDLES);
  // Without a DB lookup we only know the JWT subject (address); the
  // strict check happens in requireAdmin. This is just for log
  // shaping, so a false negative is fine.
  return allow.length > 0 && allow.includes(String(session.sub).toLowerCase());
}
