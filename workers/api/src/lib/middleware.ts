import type { Context, Next } from "hono";
import type { Env, Variables } from "./env";
import { loadSessionUserId } from "./session";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function loadSession(c: Ctx, next: Next) {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const userId = await loadSessionUserId(c.env, token);
    if (userId) {
      c.set("userId", userId);
      c.set("sessionToken", token);
      const row = await c.env.DB.prepare(`SELECT role FROM users WHERE id = ?`)
        .bind(userId)
        .first<{ role: string }>();
      if (row) c.set("userRole", row.role);
    }
  }
  await next();
}

export function requireAuth(c: Ctx, next: Next) {
  if (!c.get("userId")) return c.json({ error: "unauthorized" }, 401);
  return next();
}

const ROLE_RANK: Record<string, number> = {
  collector: 0,
  artist: 1,
  gallery: 2,
  curator: 3,
  steward: 4,
};

/** Allow either an authenticated user with the required role OR a request
 *  carrying the shared internal bot token. */
export function requireInternal(c: Ctx, next: Next) {
  const tok = c.req.header("X-Internal-Token");
  if (!tok || !c.env.INTERNAL_BOT_TOKEN || tok !== c.env.INTERNAL_BOT_TOKEN) {
    return c.json({ error: "internal_only" }, 403);
  }
  return next();
}

export function requireRole(min: keyof typeof ROLE_RANK) {
  return (c: Ctx, next: Next) => {
    if (!c.get("userId")) return c.json({ error: "unauthorized" }, 401);
    const role = c.get("userRole") ?? "collector";
    if ((ROLE_RANK[role] ?? -1) < ROLE_RANK[min]) {
      return c.json({ error: "forbidden", required: min }, 403);
    }
    return next();
  };
}
