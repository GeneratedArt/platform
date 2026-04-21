import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../lib/env";
import { requireAuth } from "../lib/middleware";
import { audit } from "../lib/audit";

export const editionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

editionRoutes.get("/:contract/:tokenId", async (c) => {
  const contract = c.req.param("contract").toLowerCase();
  const tokenId = c.req.param("tokenId");
  const edition = await c.env.DB.prepare(
    `SELECT e.*, p.slug as project_slug, p.title as project_title
     FROM editions e
     JOIN projects p ON p.id = e.project_id
     WHERE e.id = ?`
  )
    .bind(`${contract}:${tokenId}`)
    .first();
  if (!edition) return c.json({ error: "not_found" }, 404);
  return c.json({ edition });
});

const PhysicalInput = z.object({
  print_spec: z.object({
    paper: z.string().max(120),
    size: z.string().max(40),
    plotter: z.string().max(120).optional(),
    ink: z.string().max(120).optional(),
  }),
  dongle: z.string().max(120).optional(),
  shipping_address: z.string().max(2000),
});

editionRoutes.post("/:id/request-physical", requireAuth, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId")!;
  const edition = await c.env.DB.prepare(
    `SELECT id, owner_address FROM editions WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; owner_address: string }>();
  if (!edition) return c.json({ error: "not_found" }, 404);
  const user = await c.env.DB.prepare(
    `SELECT wallet_address FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ wallet_address: string | null }>();
  if (
    !user?.wallet_address ||
    user.wallet_address.toLowerCase() !== edition.owner_address.toLowerCase()
  ) {
    return c.json({ error: "not_owner" }, 403);
  }
  let parsed;
  try {
    parsed = PhysicalInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const exists = await c.env.DB.prepare(
    `SELECT 1 FROM physical_editions WHERE edition_id = ?`
  )
    .bind(id)
    .first();
  if (exists) return c.json({ error: "already_requested" }, 409);
  await c.env.DB.prepare(
    `INSERT INTO physical_editions (edition_id, dongle_serial, print_spec_json, shipped_to, status)
     VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(
      id,
      parsed.dongle ?? null,
      JSON.stringify(parsed.print_spec),
      parsed.shipping_address
    )
    .run();
  await audit(c.env, userId, "physical.request", id, { spec: parsed.print_spec });
  return c.json({ ok: true, status: "pending" });
});
