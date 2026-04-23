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

/** Caller's own projects, including drafts. The public /projects endpoint
 *  only ever returns live/sold_out, so the Studio dashboard hits this. */
meRoutes.get("/projects", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, title, description, status, edition_size, minted_count,
            github_repo, contract_address, bundle_cid, release_tag, created_at
     FROM projects WHERE artist_id = ?
     ORDER BY created_at DESC LIMIT 200`
  )
    .bind(userId)
    .all();
  return c.json({ projects: rows.results ?? [] });
});
