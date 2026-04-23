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

/** Pending collab invites addressed to the caller's wallet. Drives the
 *  "Agreement Request from @collab.eth" card on /dashboard. */
meRoutes.get("/collab-invites", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const me = await c.env.DB.prepare(`SELECT wallet_address FROM users WHERE id = ?`)
    .bind(userId).first<{ wallet_address: string | null }>();
  if (!me?.wallet_address) return c.json({ invites: [] });
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.role, c.bps, c.inviter_address, c.created_at,
            p.slug AS project_slug, p.title AS project_title
       FROM collabs c JOIN projects p ON p.id = c.project_id
      WHERE c.collaborator_address = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC LIMIT 50`
  )
    .bind(me.wallet_address.toLowerCase())
    .all();
  return c.json({ invites: rows.results ?? [] });
});
