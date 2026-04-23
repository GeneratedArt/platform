/**
 * GET /v1/stats — public homepage counters.
 *
 * Returns the four numbers the §17.1 hero caption shows. Cached at the edge
 * for 60s via the Cache API so the homepage poll (every 60s, many viewers)
 * doesn't hammer D1. The same TTL also controls browser revalidation.
 *
 * Shape (stable, additive only):
 *   { projects, artists, galleries, editions, generated_at }
 */
import { Hono } from "hono";
import type { Env, Variables } from "../lib/env";

export const statsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const TTL_SECONDS = 60;

statsRoutes.get("/", async (c) => {
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // One round-trip via D1 batch — counts are tiny and indexes already exist.
  const [projects, artists, galleries, editions] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'live'"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM artists  WHERE status = 'approved'"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM galleries"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM editions"),
  ]);

  const body = {
    projects:  Number((projects.results?.[0]  as { n?: number } | undefined)?.n ?? 0),
    artists:   Number((artists.results?.[0]   as { n?: number } | undefined)?.n ?? 0),
    galleries: Number((galleries.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    editions:  Number((editions.results?.[0]  as { n?: number } | undefined)?.n ?? 0),
    generated_at: Date.now(),
  };

  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}`,
    },
  });

  // Edge-cache a clone; the original Response is still streamable to the client.
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});
