import { Hono } from "hono";
import type { Env, Variables } from "../lib/env";
import { requireAuth } from "../lib/middleware";
import { getUserById } from "../lib/db";

export const meRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

meRoutes.get("/", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: "user_not_found" }, 404);
  const artist = await c.env.DB.prepare(
    `SELECT slug, status, website FROM artists WHERE user_id = ?`
  )
    .bind(userId)
    .first();
  return c.json({ user, artist });
});
