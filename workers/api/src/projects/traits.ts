import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getProjectById } from "../db/projects";
import {
  getMintByTokenId,
  listMintsByProject,
  listProjectTraitDistribution,
  projectMintCount,
  publicMint,
} from "../db/mints";

function badRequest(c: Context, code: string, status = 400) {
  return c.json({ error: code }, status as 400);
}

/**
 * GET /v1/projects/:id/traits
 *
 * Returns the per-project rarity distribution. For each (trait_name,
 * trait_value) pair we ship `count` (number of minted tokens carrying
 * it) and `frequency` (count / total minted), pre-grouped by name so
 * the client can render one block per trait.
 *
 * Public; cached briefly because the underlying mint count changes
 * only when a token is minted.
 */
export async function projectTraitsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  const [rows, total] = await Promise.all([
    listProjectTraitDistribution(c.env.DB, id),
    projectMintCount(c.env.DB, id),
  ]);

  // Group flat rows into { name: [{value,count,frequency}, …] } and
  // record per-name distinct counts so the client can show "3 values".
  const byName = new Map<
    string,
    { trait_value: string; count: number; frequency: number }[]
  >();
  for (const r of rows) {
    const list = byName.get(r.trait_name) ?? [];
    list.push({
      trait_value: r.trait_value,
      count: r.count,
      frequency: total > 0 ? r.count / total : 0,
    });
    byName.set(r.trait_name, list);
  }
  const traits = Array.from(byName.entries()).map(([name, values]) => ({
    name,
    values,
    distinct_count: values.length,
  }));

  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  return c.json({
    project_id: id,
    minted: total,
    traits,
  });
}

/**
 * GET /v1/projects/:id/mints
 *
 * Reverse-chronological list of minted tokens for the project, with
 * decoded trait maps. Page-capped at 100 rows.
 */
export async function projectMintsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  const limit = parseInt(c.req.query("limit") || "50", 10) || 50;
  const rows = await listMintsByProject(c.env.DB, id, { limit });
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  return c.json({
    project_id: id,
    mints: rows.map(publicMint),
  });
}

/**
 * GET /v1/projects/:id/mints/:tokenId
 *
 * Single-token detail with rarity score. Token IDs are arbitrary
 * uint256 strings, so we don't enforce numeric param syntax in the
 * route definition — instead we treat the param as opaque text and
 * let the DB lookup decide.
 *
 * Rarity score = product(1 / frequency(trait_value)) across the
 * token's traits. A higher number = rarer combination. We compute it
 * server-side so every client gets the same number and so we don't
 * have to ship the full distribution to the token page just to
 * render one figure.
 */
export async function tokenDetailHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const tokenId = c.req.param("tokenId") || "";
  if (!tokenId || tokenId.length > 80 || !/^[0-9]+$/.test(tokenId)) {
    return badRequest(c, "invalid_token_id");
  }

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  const mint = await getMintByTokenId(c.env.DB, id, tokenId);
  if (!mint) return c.json({ error: "not_found" }, 404);

  const [dist, total] = await Promise.all([
    listProjectTraitDistribution(c.env.DB, id),
    projectMintCount(c.env.DB, id),
  ]);

  const frequencies = new Map<string, number>();
  for (const r of dist) {
    if (total > 0) {
      frequencies.set(`${r.trait_name}:${r.trait_value}`, r.count / total);
    }
  }
  const decoded = publicMint(mint);
  let rarityScore: number | null = null;
  if (decoded.traits && Object.keys(decoded.traits).length > 0) {
    let product = 1;
    let any = false;
    for (const [n, v] of Object.entries(decoded.traits)) {
      const f = frequencies.get(`${n}:${v}`);
      if (f && f > 0) {
        product *= 1 / f;
        any = true;
      }
    }
    rarityScore = any ? product : null;
  }

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({
    project: {
      id: project.id,
      slug: project.slug,
      title: project.title,
      owner_id: project.owner_id,
      frozen_cid: project.frozen_cid,
      contract_address: project.contract_address,
      chain_id: project.chain_id,
    },
    mint: decoded,
    rarity_score: rarityScore,
  });
}
