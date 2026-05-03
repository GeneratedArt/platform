import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { searchAll, SEARCH_DEFAULTS, type SearchKind } from "../db/search";

const ALLOWED_KINDS: SearchKind[] = ["all", "projects", "artists", "briefs"];

/**
 * GET /v1/search?q=…&kind={all,projects,artists,briefs}&limit=N
 *
 * Public, single FTS5 query across users + projects + briefs. The
 * response is GROUPED rather than flat so the UI can render three
 * tidy lists without re-bucketing on the client. Cache-Control is
 * conservative (60s) — search rankings shift slowly enough that an
 * edge cache is fine, but we don't want a curated brief that just
 * went live to wait an hour to surface.
 */
export async function searchHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ error: "missing_q" }, 400);
  if (q.length > 200) return c.json({ error: "q_too_long" }, 400);

  const kindRaw = (c.req.query("kind") || "all") as SearchKind;
  const kind = ALLOWED_KINDS.includes(kindRaw) ? kindRaw : "all";

  const limitRaw = parseInt(c.req.query("limit") || "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? limitRaw
    : SEARCH_DEFAULTS.PER_KIND_DEFAULT;

  const results = await searchAll(c.env.DB, q, kind, limit);
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({
    q,
    kind,
    projects: results.projects,
    artists: results.artists,
    briefs: results.briefs,
  });
}
