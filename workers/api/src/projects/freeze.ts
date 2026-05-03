import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { getProjectById } from "../db/projects";
import {
  insertFrozenVersion,
  listFrozenForProject,
  getActiveFrozenForProject,
  getFrozenById,
  activateFrozenVersion,
  publicFrozen,
} from "../db/frozen";
import { buildBundle } from "../lib/freeze";
import { pinBundle } from "../lib/pinning";

/**
 * POST /v1/projects/:id/freeze
 *
 * Owner-only. Builds a deterministic bundle for the project's repo at
 * the requested commit (or "latest"), pins it to web3.storage and
 * Pinata in parallel, and writes a `frozen_versions` row. The new row
 * is NOT activated automatically — the owner picks which version is
 * live via the activate endpoint, so a bad freeze doesn't silently
 * change what mints would lock.
 *
 * Pinning policy:
 *   - Both providers unconfigured AND PINNING_MOCK!=1 → 503
 *     `pinning_unconfigured`. We refuse to start a freeze whose
 *     pinned CID would only be a local fallback.
 *   - Both providers configured but BOTH fail at runtime → 502
 *     `pin_failed`, no row written. A frozen row that nothing on the
 *     IPFS network can resolve is worse than no row.
 *   - Exactly one provider succeeds → row written with
 *     `pinning_partial=true` and `pin_errors` populated. The owner
 *     can retry; the cron also reattempts the dropped provider.
 */
export async function freezeProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return c.json({ error: "invalid_id" }, 400);

  const session = getAuthUser(c);
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (session.uid !== project.owner_id) {
    return c.json({ error: "forbidden" }, 403);
  }

  type Body = { commit?: unknown };
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const commitInput =
    typeof body.commit === "string" && body.commit.trim().length > 0
      ? body.commit.trim()
      : "latest";

  const noProviders = !c.env.W3S_TOKEN && !c.env.PINATA_JWT;
  const isMock = c.env.PINNING_MOCK === "1";
  if (noProviders && !isMock) {
    return c.json({ error: "pinning_unconfigured" }, 503);
  }

  let bundle;
  try {
    bundle = await buildBundle(c.env, {
      repoFull: project.repo_full,
      engine: project.engine,
      title: project.title,
      commit: commitInput,
      projectId: project.id,
    });
  } catch (err) {
    console.error("freeze_bundle_failed", err);
    return c.json(
      { error: "bundle_failed", detail: String(err) },
      502,
    );
  }

  const pin = await pinBundle(c.env, {
    bytes: bundle.bytes,
    filename: `project-${project.id}-${bundle.bundle_hash.slice(0, 8)}.html`,
  });

  // Refuse to write a row when no provider returned a CID. The
  // local fallback CID would resolve nowhere on the IPFS network,
  // which is the exact failure mode this feature is preventing.
  // Mock mode is the one exception — we substitute the locally
  // computed CID so dev/CI flows remain testable end-to-end.
  let resolvedCid = pin.cid;
  if (!resolvedCid) {
    if (isMock) {
      resolvedCid = bundle.local_cid;
      pin.pinned_w3s = true;
      pin.pinned_pinata = true;
      pin.partial = false;
    } else {
      return c.json({ error: "pin_failed", detail: pin.errors }, 502);
    }
  }

  const row = await insertFrozenVersion(c.env.DB, {
    project_id: project.id,
    commit_sha: bundle.commit_sha,
    cid: resolvedCid,
    bundle_hash: bundle.bundle_hash,
    bytes: bundle.bytes.length,
    pinned_w3s: pin.pinned_w3s,
    pinned_pinata: pin.pinned_pinata,
    pinning_partial: pin.partial,
    pin_errors: Object.keys(pin.errors).length > 0 ? pin.errors : null,
  });

  return c.json({ frozen: publicFrozen(row) }, 201);
}

/**
 * GET /v1/projects/:id/frozen
 *
 * Lists all frozen versions for a project, newest first. Public —
 * the bundle CID and hash are already on-chain (or about to be), so
 * there's no value in hiding them.
 */
export async function listFrozen(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return c.json({ error: "invalid_id" }, 400);

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  const rows = await listFrozenForProject(c.env.DB, project.id);
  const active = rows.find((r) => r.is_active === 1) ?? null;
  return c.json({
    versions: rows.map(publicFrozen),
    active: active ? publicFrozen(active) : null,
  });
}

/**
 * POST /v1/projects/:id/frozen/:fid/activate
 *
 * Owner-only. Sets the chosen frozen version as the active one and
 * mirrors its CID into projects.frozen_cid so the existing
 * `lock_cid` mint phase keeps working without changes.
 */
export async function activateFrozen(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  const fid = parseInt(c.req.param("fid") || "", 10);
  if (!id || Number.isNaN(id)) return c.json({ error: "invalid_id" }, 400);
  if (!fid || Number.isNaN(fid)) return c.json({ error: "invalid_fid" }, 400);

  const session = getAuthUser(c);
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (session.uid !== project.owner_id) {
    return c.json({ error: "forbidden" }, 403);
  }

  const target = await getFrozenById(c.env.DB, fid);
  if (!target || target.project_id !== project.id) {
    return c.json({ error: "frozen_not_found" }, 404);
  }
  if (!target.pinned_w3s && !target.pinned_pinata) {
    return c.json({ error: "frozen_not_pinned" }, 409);
  }

  const activated = await activateFrozenVersion(c.env.DB, project.id, fid);
  if (!activated) return c.json({ error: "activate_failed" }, 500);
  return c.json({ frozen: publicFrozen(activated) });
}

/// Helper exposed for the mint guard: returns the active frozen
/// version's CID, or null if the project has no active version.
export async function activeFrozenCid(
  env: Env,
  projectId: number,
): Promise<string | null> {
  const row = await getActiveFrozenForProject(env.DB, projectId);
  return row ? row.cid : null;
}
