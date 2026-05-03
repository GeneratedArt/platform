import type { D1Database } from "@cloudflare/workers-types";

export interface FrozenVersionRow {
  id: number;
  project_id: number;
  commit_sha: string;
  /// "Primary" CID, kept for backwards-compat and the projects.frozen_cid
  /// mirror. Defaults to the first successful provider's CID. The
  /// per-provider columns below are the source of truth for gateway
  /// resolution.
  cid: string;
  cid_w3s: string | null;
  cid_pinata: string | null;
  bundle_hash: string;
  bytes: number;
  pinned_w3s: number;
  pinned_pinata: number;
  pinning_partial: number;
  pin_errors: string | null;
  is_active: number;
  last_checked_at: number | null;
  created_at: number;
}

export interface FrozenVersionPublic {
  id: number;
  commit_sha: string;
  cid: string;
  cid_w3s: string | null;
  cid_pinata: string | null;
  bundle_hash: string;
  bytes: number;
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  pinning_partial: boolean;
  pin_errors: unknown;
  is_active: boolean;
  last_checked_at: number | null;
  created_at: number;
  gateways: { w3s: string | null; pinata: string | null };
}

export function publicFrozen(row: FrozenVersionRow): FrozenVersionPublic {
  let pin_errors: unknown = null;
  if (row.pin_errors) {
    try {
      pin_errors = JSON.parse(row.pin_errors);
    } catch {
      pin_errors = row.pin_errors;
    }
  }
  return {
    id: row.id,
    commit_sha: row.commit_sha,
    cid: row.cid,
    cid_w3s: row.cid_w3s,
    cid_pinata: row.cid_pinata,
    bundle_hash: row.bundle_hash,
    bytes: row.bytes,
    pinned_w3s: row.pinned_w3s === 1,
    pinned_pinata: row.pinned_pinata === 1,
    pinning_partial: row.pinning_partial === 1,
    pin_errors,
    is_active: row.is_active === 1,
    last_checked_at: row.last_checked_at,
    created_at: row.created_at,
    gateways: {
      // Each gateway is anchored to that provider's actual CID, not
      // a shared "primary" CID — the providers' CIDs differ by
      // construction so a single shared URL would 404 on whichever
      // provider didn't return that CID.
      w3s: row.cid_w3s ? `https://${row.cid_w3s}.ipfs.w3s.link/` : null,
      pinata: row.cid_pinata
        ? `https://gateway.pinata.cloud/ipfs/${row.cid_pinata}/`
        : null,
    },
  };
}

export interface InsertFrozenInput {
  project_id: number;
  commit_sha: string;
  cid: string;
  cid_w3s: string | null;
  cid_pinata: string | null;
  bundle_hash: string;
  bytes: number;
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  pinning_partial: boolean;
  pin_errors: unknown;
}

export async function insertFrozenVersion(
  db: D1Database,
  input: InsertFrozenInput,
): Promise<FrozenVersionRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO frozen_versions
         (project_id, commit_sha, cid, cid_w3s, cid_pinata,
          bundle_hash, bytes,
          pinned_w3s, pinned_pinata, pinning_partial, pin_errors,
          is_active, last_checked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.project_id,
      input.commit_sha,
      input.cid,
      input.cid_w3s,
      input.cid_pinata,
      input.bundle_hash,
      input.bytes,
      input.pinned_w3s ? 1 : 0,
      input.pinned_pinata ? 1 : 0,
      input.pinning_partial ? 1 : 0,
      input.pin_errors ? JSON.stringify(input.pin_errors) : null,
      now,
      now,
    )
    .first<FrozenVersionRow>();
  if (!row) throw new Error("frozen_insert_failed");
  return row;
}

export async function listFrozenForProject(
  db: D1Database,
  projectId: number,
): Promise<FrozenVersionRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM frozen_versions WHERE project_id = ? ORDER BY created_at DESC",
    )
    .bind(projectId)
    .all<FrozenVersionRow>();
  return r.results ?? [];
}

export async function getFrozenById(
  db: D1Database,
  fid: number,
): Promise<FrozenVersionRow | null> {
  return db
    .prepare("SELECT * FROM frozen_versions WHERE id = ?")
    .bind(fid)
    .first<FrozenVersionRow>();
}

export async function getActiveFrozenForProject(
  db: D1Database,
  projectId: number,
): Promise<FrozenVersionRow | null> {
  return db
    .prepare(
      "SELECT * FROM frozen_versions WHERE project_id = ? AND is_active = 1",
    )
    .bind(projectId)
    .first<FrozenVersionRow>();
}

/// Atomically deactivate any current active row and activate the
/// supplied one. Returns the activated row, or null if `fid` doesn't
/// belong to `projectId`.
export async function activateFrozenVersion(
  db: D1Database,
  projectId: number,
  fid: number,
): Promise<FrozenVersionRow | null> {
  const target = await db
    .prepare("SELECT * FROM frozen_versions WHERE id = ? AND project_id = ?")
    .bind(fid, projectId)
    .first<FrozenVersionRow>();
  if (!target) return null;
  // Two-step: clear the current active flag, then set ours. The
  // partial unique index would otherwise reject the second update if
  // we tried to set is_active=1 before clearing the previous one.
  // db.batch() runs all statements in a single transaction in D1,
  // so either every statement commits or none do — the partial
  // unique index can't observe an intermediate "two active rows"
  // state from a concurrent reader.
  await db.batch([
    db
      .prepare(
        "UPDATE frozen_versions SET is_active = 0 WHERE project_id = ? AND is_active = 1 AND id != ?",
      )
      .bind(projectId, fid),
    db
      .prepare(
        "UPDATE frozen_versions SET is_active = 1 WHERE id = ?",
      )
      .bind(fid),
    // Mirror the active CID into projects.frozen_cid so the existing
    // `lock_cid` mint phase keeps working without a schema change.
    db
      .prepare(
        "UPDATE projects SET frozen_cid = ?, updated_at = ? WHERE id = ?",
      )
      .bind(target.cid, Math.floor(Date.now() / 1000), projectId),
  ]);
  return getFrozenById(db, fid);
}

export async function listFrozenForCronAudit(
  db: D1Database,
  limit = 50,
): Promise<FrozenVersionRow[]> {
  // Re-check the rows that haven't been checked recently or that have
  // a known partial-pin state. Order by oldest-checked-first so the
  // cron doesn't starve any one row.
  const r = await db
    .prepare(
      `SELECT * FROM frozen_versions
       ORDER BY (last_checked_at IS NULL) DESC,
                last_checked_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<FrozenVersionRow>();
  return r.results ?? [];
}

export async function updatePinState(
  db: D1Database,
  fid: number,
  patch: {
    pinned_w3s?: boolean;
    pinned_pinata?: boolean;
    pinning_partial?: boolean;
    pin_errors?: unknown;
    cid_w3s?: string | null;
    cid_pinata?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.pinned_w3s !== undefined) {
    sets.push("pinned_w3s = ?");
    binds.push(patch.pinned_w3s ? 1 : 0);
  }
  if (patch.pinned_pinata !== undefined) {
    sets.push("pinned_pinata = ?");
    binds.push(patch.pinned_pinata ? 1 : 0);
  }
  if (patch.pinning_partial !== undefined) {
    sets.push("pinning_partial = ?");
    binds.push(patch.pinning_partial ? 1 : 0);
  }
  if (patch.pin_errors !== undefined) {
    sets.push("pin_errors = ?");
    binds.push(patch.pin_errors ? JSON.stringify(patch.pin_errors) : null);
  }
  if (patch.cid_w3s !== undefined) {
    sets.push("cid_w3s = ?");
    binds.push(patch.cid_w3s);
  }
  if (patch.cid_pinata !== undefined) {
    sets.push("cid_pinata = ?");
    binds.push(patch.cid_pinata);
  }
  sets.push("last_checked_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(fid);
  await db
    .prepare(`UPDATE frozen_versions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}
