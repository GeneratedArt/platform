import { Hono } from "hono";
import type { Env, Variables } from "../lib/env";

export const ownerRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

ownerRoutes.get("/:address/editions", async (c) => {
  const address = c.req.param("address").toLowerCase();
  // Join through to the project so the collector page can render the live
  // bundle without N+1 follow-up requests.
  const rows = await c.env.DB.prepare(
    `SELECT e.*, p.slug as project_slug, p.title as project_title,
            p.bundle_cid as bundle_cid, p.contract_address as contract_address
     FROM editions e
     JOIN projects p ON p.id = e.project_id
     WHERE e.owner_address = ?
     ORDER BY e.minted_at DESC LIMIT 200`
  )
    .bind(address)
    .all();
  return c.json({ editions: rows.results ?? [] });
});
