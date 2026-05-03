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
import { recordEvent } from "../db/events";

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
  // computed CID for both providers so dev/CI flows remain
  // testable end-to-end.
  let resolvedCid = pin.cid;
  let cidW3s = pin.cid_w3s;
  let cidPinata = pin.cid_pinata;
  if (!resolvedCid) {
    if (isMock) {
      resolvedCid = bundle.local_cid;
      cidW3s = bundle.local_cid;
      cidPinata = bundle.local_cid;
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
    cid_w3s: cidW3s,
    cid_pinata: cidPinata,
    bundle_hash: bundle.bundle_hash,
    bytes: bundle.bytes.length,
    pinned_w3s: pin.pinned_w3s,
    pinned_pinata: pin.pinned_pinata,
    pinning_partial: pin.partial,
    pin_errors: Object.keys(pin.errors).length > 0 ? pin.errors : null,
  });

  try {
    await recordEvent(c.env.DB, {
      kind: "freeze",
      actor_id: session.uid,
      target_kind: "frozen",
      target_id: row.id,
      payload: {
        project_id: project.id,
        title: project.title,
        slug: project.slug,
        commit_sha: row.commit_sha,
        cid: row.cid,
        bundle_hash: row.bundle_hash,
      },
    });
  } catch (e) {
    console.error("event_freeze_failed", e);
  }
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

/**
 * POST /v1/projects/:id/frozen/:fid/retry-pin
 *
 * Owner-only. Rebuilds the bundle deterministically from the row's
 * stored `commit_sha`, verifies the rebuilt bytes hash to the same
 * `bundle_hash` (so a force-push can't silently swap the contents
 * we re-pin), and re-uploads to whichever providers are currently
 * marked unpinned. Mirrors the cron's recovery logic but runs
 * synchronously on the owner's request.
 */
export async function retryPinFrozen(
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

  const row = await getFrozenById(c.env.DB, fid);
  if (!row || row.project_id !== project.id) {
    return c.json({ error: "frozen_not_found" }, 404);
  }
  if (row.pinned_w3s === 1 && row.pinned_pinata === 1) {
    return c.json({ error: "already_fully_pinned" }, 409);
  }

  const isMock = c.env.PINNING_MOCK === "1";
  if (!c.env.W3S_TOKEN && !c.env.PINATA_JWT && !isMock) {
    return c.json({ error: "pinning_unconfigured" }, 503);
  }

  // Deterministic rebuild from the stored commit SHA.
  let rebuilt;
  try {
    rebuilt = await buildBundle(c.env, {
      repoFull: project.repo_full,
      engine: project.engine,
      title: project.title,
      commit: row.commit_sha,
      projectId: project.id,
    });
  } catch (err) {
    console.error("retry_pin_rebuild_failed", row.id, err);
    return c.json({ error: "bundle_failed", detail: String(err) }, 502);
  }
  if (rebuilt.bundle_hash !== row.bundle_hash) {
    // Repo has been force-pushed or the runtime version drifted —
    // refuse to re-pin different bytes under the original hash.
    return c.json(
      {
        error: "rebuild_hash_mismatch",
        expected: row.bundle_hash,
        got: rebuilt.bundle_hash,
      },
      409,
    );
  }

  const filename = `project-${project.id}-${row.bundle_hash.slice(0, 8)}.html`;
  const errors: Record<string, string> = {};
  let recoveredW3s = row.pinned_w3s === 1;
  let recoveredPinata = row.pinned_pinata === 1;
  let cidW3s: string | null = row.cid_w3s;
  let cidPinata: string | null = row.cid_pinata;

  const { repinTo } = await import("../lib/pinning");
  if (!recoveredW3s && c.env.W3S_TOKEN) {
    try {
      const r = await repinTo(c.env, "w3s", { bytes: rebuilt.bytes, filename });
      cidW3s = r.cid;
      recoveredW3s = true;
    } catch (err) {
      errors.w3s = String(err);
    }
  }
  if (!recoveredPinata && c.env.PINATA_JWT) {
    try {
      const r = await repinTo(c.env, "pinata", {
        bytes: rebuilt.bytes,
        filename,
      });
      cidPinata = r.cid;
      recoveredPinata = true;
    } catch (err) {
      errors.pinata = String(err);
    }
  }
  if (isMock) {
    // Dev/CI: pretend both providers are happy and adopt the local
    // CID for whichever side wasn't already set.
    cidW3s = cidW3s ?? rebuilt.local_cid;
    cidPinata = cidPinata ?? rebuilt.local_cid;
    recoveredW3s = true;
    recoveredPinata = true;
  }

  const { updatePinState } = await import("../db/frozen");
  await updatePinState(c.env.DB, row.id, {
    pinned_w3s: recoveredW3s,
    pinned_pinata: recoveredPinata,
    pinning_partial: !(recoveredW3s && recoveredPinata),
    pin_errors: Object.keys(errors).length > 0 ? errors : null,
    cid_w3s: cidW3s,
    cid_pinata: cidPinata,
  });

  const updated = await getFrozenById(c.env.DB, row.id);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ frozen: publicFrozen(updated) });
}
