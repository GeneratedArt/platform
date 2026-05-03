import type { D1Database } from "@cloudflare/workers-types";
import type { UserRow } from "../types";

function generateHandle(address: string): string {
  return `artist_${address.slice(2, 8).toLowerCase()}`;
}

export async function upsertUserByAddress(
  db: D1Database,
  address: string,
): Promise<UserRow> {
  const normalized = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare("SELECT * FROM users WHERE address = ?")
    .bind(normalized)
    .first<UserRow>();
  if (existing) {
    return existing;
  }
  const handle = generateHandle(normalized);
  const result = await db
    .prepare(
      `INSERT INTO users (address, handle, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(normalized, handle, now, now)
    .first<UserRow>();
  if (!result) {
    throw new Error("failed_to_insert_user");
  }
  return result;
}

export async function getUserById(
  db: D1Database,
  id: number,
): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getUserByHandle(
  db: D1Database,
  handle: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE handle = ?")
    .bind(handle.toLowerCase())
    .first<UserRow>();
}

export interface UserProfilePatch {
  handle?: string;
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  cover_image?: string | null;
  socials?: Array<{ label: string; url: string }> | null;
}

/**
 * Apply a partial update to the user row. Returns null when no fields
 * were changed (caller can re-read for current state). Handle uniqueness
 * is enforced at the DB level by the existing UNIQUE constraint and
 * surfaces as a SQLITE_CONSTRAINT error — caller must trap and translate.
 */
export async function updateUserProfile(
  db: D1Database,
  id: number,
  patch: UserProfilePatch,
): Promise<UserRow | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.handle !== undefined) {
    sets.push("handle = ?");
    binds.push(patch.handle.toLowerCase());
  }
  if (patch.display_name !== undefined) {
    sets.push("display_name = ?");
    binds.push(patch.display_name);
  }
  if (patch.bio !== undefined) {
    sets.push("bio = ?");
    binds.push(patch.bio);
  }
  if (patch.avatar_url !== undefined) {
    sets.push("avatar_url = ?");
    binds.push(patch.avatar_url);
  }
  if (patch.cover_image !== undefined) {
    sets.push("cover_image = ?");
    binds.push(patch.cover_image);
  }
  if (patch.socials !== undefined) {
    sets.push("socials = ?");
    binds.push(patch.socials === null ? null : JSON.stringify(patch.socials));
  }
  if (sets.length === 0) {
    return getUserById(db, id);
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(id);
  const sql = `UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(sql).bind(...binds).first<UserRow>();
}
