import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { Env, Variables } from "../lib/env";
import { requireRole, requireAuth } from "../lib/middleware";
import { audit } from "../lib/audit";

export const galleryRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateGallery = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  name: z.string().min(1).max(120),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  description: z.string().max(4000).optional(),
  steward_user_id: z.string().optional(),
  physical: z.boolean().default(false),
});

const CreateExhibition = z.object({
  title: z.string().min(1).max(200),
  starts_at: z.number().int(),
  ends_at: z.number().int().optional(),
  project_ids: z.array(z.string()).min(1).max(100),
});

galleryRoutes.post("/", requireRole("steward"), async (c) => {
  const actor = c.get("userId")!;
  let parsed;
  try {
    parsed = CreateGallery.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const taken = await c.env.DB.prepare(`SELECT 1 FROM galleries WHERE slug = ?`)
    .bind(parsed.slug)
    .first();
  if (taken) return c.json({ error: "slug_taken" }, 409);
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO galleries (id, slug, name, city, country, description, steward_user_id, physical)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      parsed.slug,
      parsed.name,
      parsed.city ?? null,
      parsed.country ?? null,
      parsed.description ?? null,
      parsed.steward_user_id ?? actor,
      parsed.physical ? 1 : 0
    )
    .run();
  await audit(c.env, actor, "gallery.create", id, { slug: parsed.slug });
  return c.json({ id, slug: parsed.slug });
});

galleryRoutes.post("/:slug/exhibitions", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId")!;
  const role = c.get("userRole") ?? "collector";
  const gallery = await c.env.DB.prepare(
    `SELECT id, steward_user_id FROM galleries WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; steward_user_id: string | null }>();
  if (!gallery) return c.json({ error: "not_found" }, 404);
  if (
    gallery.steward_user_id !== userId &&
    role !== "curator" &&
    role !== "steward"
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  let parsed;
  try {
    parsed = CreateExhibition.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO exhibitions (id, gallery_id, title, starts_at, ends_at, project_ids_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      gallery.id,
      parsed.title,
      parsed.starts_at,
      parsed.ends_at ?? null,
      JSON.stringify(parsed.project_ids)
    )
    .run();
  await audit(c.env, userId, "exhibition.create", id, { gallery: slug, title: parsed.title });
  return c.json({ id, gallery_slug: slug });
});
