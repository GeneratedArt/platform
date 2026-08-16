// Env-var-gated admin middleware. Closed-by-default: when
// ADMIN_HANDLES is unset or empty the route 403s admin_unconfigured.
// Runs after requireAuth so c.get("user") is populated.

import type { MiddlewareHandler } from "hono";
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
// NOTE: an `isAdminContext(c)` helper used to live here, comparing the
// JWT `sub` (a 0x… address) against ADMIN_HANDLES (handles). Those two
// namespaces never intersect, so it returned false unconditionally. It
// had no callers; rather than leave a helper that silently fails open or
// closed depending on how a future caller reads it, the admin check is
// `requireAdmin` above and nothing else. Anything needing a cheap
// pre-check must resolve the handle from D1 the same way requireAdmin
// does.
