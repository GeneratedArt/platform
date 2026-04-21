import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { Env, Variables } from "../lib/env";
import { requireAuth, requireRole } from "../lib/middleware";
import { audit } from "../lib/audit";
import { createArtRepo } from "../lib/github-app";

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateInput = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  description: z.string().max(4000).default(""),
  edition_size: z.number().int().min(1).max(100000),
  price_eth: z.number().min(0),
  royalty_bps: z.number().int().min(0).max(1000).default(750),
  license: z.string().default("CC-BY-NC-4.0"),
});

function ethToWei(eth: number): string {
  const [whole, frac = ""] = String(eth).split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return (BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0")).toString();
}

projectRoutes.post("/", requireRole("artist"), async (c) => {
  const userId = c.get("userId")!;
  let parsed;
  try {
    parsed = CreateInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const taken = await c.env.DB.prepare(`SELECT 1 FROM projects WHERE slug = ?`)
    .bind(parsed.slug)
    .first();
  if (taken) return c.json({ error: "slug_taken" }, 409);

  let repo;
  try {
    repo = await createArtRepo(c.env, parsed.slug, parsed.description || parsed.title);
  } catch (err) {
    return c.json(
      { error: "repo_create_failed", detail: (err as Error).message },
      503
    );
  }

  const id = ulid();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, artist_id, slug, title, description, github_repo,
                           license, edition_size, price_wei, royalty_bps, status, created_at, minted_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 0)`
  )
    .bind(
      id,
      userId,
      parsed.slug,
      parsed.title,
      parsed.description,
      repo.full_name,
      parsed.license,
      parsed.edition_size,
      ethToWei(parsed.price_eth),
      parsed.royalty_bps,
      now
    )
    .run();
  await audit(c.env, userId, "project.create", id, { slug: parsed.slug, repo: repo.full_name });
  return c.json({
    id,
    slug: parsed.slug,
    repo: repo.full_name,
    clone_url: repo.clone_url,
    html_url: repo.html_url,
  });
});

projectRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const sql = status
    ? `SELECT id, slug, title, description, edition_size, minted_count, status, contract_address, created_at
       FROM projects WHERE status = ? ORDER BY created_at DESC LIMIT 100`
    : `SELECT id, slug, title, description, edition_size, minted_count, status, contract_address, created_at
       FROM projects WHERE status IN ('live','sold_out') ORDER BY created_at DESC LIMIT 100`;
  const stmt = status ? c.env.DB.prepare(sql).bind(status) : c.env.DB.prepare(sql);
  const rows = await stmt.all();
  return c.json({ projects: rows.results ?? [] });
});

projectRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const project = await c.env.DB.prepare(
    `SELECT * FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first();
  if (!project) return c.json({ error: "not_found" }, 404);
  return c.json({ project });
});

projectRoutes.post("/:slug/submit", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId")!;
  const project = await c.env.DB.prepare(
    `SELECT id, artist_id, status, github_repo FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; artist_id: string; status: string; github_repo: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.artist_id !== userId) return c.json({ error: "forbidden" }, 403);
  if (project.status !== "draft") return c.json({ error: "invalid_status", current: project.status }, 409);
  await c.env.DB.prepare(`UPDATE projects SET status = 'review' WHERE id = ?`)
    .bind(project.id)
    .run();
  await audit(c.env, userId, "project.submit", project.id, { slug, repo: project.github_repo });
  return c.json({ ok: true, status: "review" });
});

projectRoutes.post("/:slug/approve", requireRole("curator"), async (c) => {
  const slug = c.req.param("slug");
  const actor = c.get("userId")!;
  const project = await c.env.DB.prepare(
    `SELECT id, status FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; status: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.status !== "review") return c.json({ error: "invalid_status", current: project.status }, 409);
  await c.env.DB.prepare(`UPDATE projects SET status = 'approved' WHERE id = ?`)
    .bind(project.id)
    .run();
  await audit(c.env, actor, "project.approve", project.id, { slug });
  await c.env.PIN_QUEUE.send({ type: "project.approved", project_id: project.id, slug });
  return c.json({
    ok: true,
    status: "approved",
    note: "Release tag, IPFS pin, and on-chain factory.createProject() will be processed by the deploy pipeline.",
  });
});

projectRoutes.post("/:slug/archive", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId")!;
  const role = c.get("userRole") ?? "collector";
  const project = await c.env.DB.prepare(
    `SELECT id, artist_id FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; artist_id: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.artist_id !== userId && role !== "curator" && role !== "steward") {
    return c.json({ error: "forbidden" }, 403);
  }
  await c.env.DB.prepare(`UPDATE projects SET status = 'archived' WHERE id = ?`)
    .bind(project.id)
    .run();
  await audit(c.env, userId, "project.archive", project.id, { slug });
  return c.json({ ok: true, status: "archived" });
});

projectRoutes.get("/:slug/mint-params", async (c) => {
  const slug = c.req.param("slug");
  const project = await c.env.DB.prepare(
    `SELECT contract_address, price_wei, edition_size, minted_count
     FROM projects WHERE slug = ? AND status = 'live'`
  )
    .bind(slug)
    .first<{
      contract_address: string;
      price_wei: string;
      edition_size: number;
      minted_count: number;
    }>();
  if (!project?.contract_address) return c.json({ error: "not_live" }, 404);
  return c.json({
    contract: project.contract_address,
    price_wei: project.price_wei,
    chain_id: Number(c.env.CHAIN_ID),
    remaining: project.edition_size - project.minted_count,
  });
});

const PreviewInput = z.object({
  token_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

projectRoutes.post("/:slug/preview", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId")!;
  let parsed;
  try {
    parsed = PreviewInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }
  const project = await c.env.DB.prepare(
    `SELECT id, github_repo, release_tag FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; github_repo: string; release_tag: string | null }>();
  if (!project) return c.json({ error: "not_found" }, 404);
  const r2Key = `previews/${slug}/${parsed.token_hash}.png`;
  await c.env.RENDER_QUEUE.send({
    type: "preview",
    project_id: project.id,
    slug,
    repo: project.github_repo,
    tag: project.release_tag,
    token_hash: parsed.token_hash,
    r2_key: r2Key,
    requested_by: userId,
  });
  await audit(c.env, userId, "project.preview.queue", project.id, { token_hash: parsed.token_hash });
  return c.json({ queued: true, r2_key: r2Key, eta_seconds: 30 });
});
