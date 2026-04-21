import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../lib/env";
import { requireAuth, requireRole } from "../lib/middleware";
import { audit } from "../lib/audit";

export const artistRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const ApplyInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  bio: z.string().max(2000),
  portfolio_links: z.array(z.string().url()).max(10).default([]),
  website: z.string().url().optional(),
});

const PatchInput = z.object({
  bio: z.string().max(2000).optional(),
  display_name: z.string().max(120).optional(),
  website: z.string().url().optional(),
  socials_json: z.record(z.string(), z.string()).optional(),
});

artistRoutes.post("/apply", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  let parsed;
  try {
    parsed = ApplyInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const taken = await c.env.DB.prepare(`SELECT 1 FROM artists WHERE slug = ?`)
    .bind(parsed.slug)
    .first();
  if (taken) return c.json({ error: "slug_taken" }, 409);
  const existing = await c.env.DB.prepare(`SELECT 1 FROM artists WHERE user_id = ?`)
    .bind(userId)
    .first();
  if (existing) return c.json({ error: "already_applied" }, 409);
  await c.env.DB.prepare(
    `INSERT INTO artists (user_id, slug, website, socials_json, status)
     VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(userId, parsed.slug, parsed.website ?? null, JSON.stringify({ portfolio_links: parsed.portfolio_links }))
    .run();
  await c.env.DB.prepare(`UPDATE users SET bio = ? WHERE id = ?`)
    .bind(parsed.bio, userId)
    .run();
  await audit(c.env, userId, "artist.apply", parsed.slug, { slug: parsed.slug });
  return c.json({ ok: true, slug: parsed.slug, status: "pending" });
});

artistRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const artist = await c.env.DB.prepare(
    `SELECT a.user_id, a.slug, a.website, a.socials_json, a.status, a.approved_at,
            u.display_name, u.bio, u.avatar_r2_key, u.github_login, u.wallet_address
     FROM artists a JOIN users u ON u.id = a.user_id
     WHERE a.slug = ?`
  )
    .bind(slug)
    .first();
  if (!artist) return c.json({ error: "not_found" }, 404);
  return c.json({ artist });
});

artistRoutes.patch("/:slug", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId")!;
  const role = c.get("userRole") ?? "collector";
  const artist = await c.env.DB.prepare(
    `SELECT user_id FROM artists WHERE slug = ?`
  )
    .bind(slug)
    .first<{ user_id: string }>();
  if (!artist) return c.json({ error: "not_found" }, 404);
  if (artist.user_id !== userId && role !== "curator" && role !== "steward") {
    return c.json({ error: "forbidden" }, 403);
  }
  let parsed;
  try {
    parsed = PatchInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  if (parsed.website !== undefined || parsed.socials_json !== undefined) {
    await c.env.DB.prepare(
      `UPDATE artists SET website = COALESCE(?, website),
                          socials_json = COALESCE(?, socials_json)
       WHERE slug = ?`
    )
      .bind(
        parsed.website ?? null,
        parsed.socials_json ? JSON.stringify(parsed.socials_json) : null,
        slug
      )
      .run();
  }
  if (parsed.bio !== undefined || parsed.display_name !== undefined) {
    await c.env.DB.prepare(
      `UPDATE users SET bio = COALESCE(?, bio),
                        display_name = COALESCE(?, display_name)
       WHERE id = ?`
    )
      .bind(parsed.bio ?? null, parsed.display_name ?? null, artist.user_id)
      .run();
  }
  await audit(c.env, userId, "artist.update", slug, parsed);
  return c.json({ ok: true });
});

artistRoutes.post("/:slug/approve", requireRole("curator"), async (c) => {
  const slug = c.req.param("slug");
  const actor = c.get("userId")!;
  const artist = await c.env.DB.prepare(
    `SELECT user_id, status FROM artists WHERE slug = ?`
  )
    .bind(slug)
    .first<{ user_id: string; status: string }>();
  if (!artist) return c.json({ error: "not_found" }, 404);
  if (artist.status === "approved") return c.json({ ok: true, already: true });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE artists SET status = 'approved', approved_at = ?, approved_by = ? WHERE slug = ?`
    ).bind(Date.now(), actor, slug),
    c.env.DB.prepare(
      `UPDATE users SET role = CASE WHEN role = 'collector' THEN 'artist' ELSE role END WHERE id = ?`
    ).bind(artist.user_id),
  ]);
  await audit(c.env, actor, "artist.approve", slug, { user_id: artist.user_id });
  return c.json({ ok: true });
});
