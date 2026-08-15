import type { D1Database } from "@cloudflare/workers-types";
import type { UserRow } from "../types";

// Must satisfy the profile handle regex `^[a-z0-9][a-z0-9-]{1,30}$`.
//
// `attempt` widens the address slice on each retry. `users.handle` is
// UNIQUE, and six hex chars is only 16.7M values — by the birthday bound
// two of a few thousand signups collide with better-than-even odds, and
// the loser's very first sign-in would 500 forever on the constraint.
// Widening to the full 40-char address makes a collision equivalent to an
// address collision; the random suffix is the last-resort tiebreak for a
// genuine race between two concurrent first-time sign-ins.
function generateHandle(address: string, attempt: number): string {
  const hex = address.replace(/^0x/, "").toLowerCase();
  if (attempt === 0) return `artist-${hex.slice(0, 6)}`;
  if (attempt === 1) return `artist-${hex.slice(0, 12)}`;
  if (attempt === 2) return `artist-${hex.slice(0, 23)}`;
  const suffix = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `artist-${hex.slice(0, 16)}-${suffix}`;
}

const HANDLE_ATTEMPTS = 6;

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

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
    const handle = generateHandle(normalized, attempt);
    try {
      const result = await db
        .prepare(
          `INSERT INTO users (address, handle, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           RETURNING *`,
        )
        .bind(normalized, handle, now, now)
        .first<UserRow>();
      if (result) return result;
      throw new Error("failed_to_insert_user");
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(msg)) throw err;
      // The address itself may have raced in from a concurrent sign-in;
      // if so the row now exists and is the right answer.
      const raced = await db
        .prepare("SELECT * FROM users WHERE address = ?")
        .bind(normalized)
        .first<UserRow>();
      if (raced) return raced;
      // Otherwise it was the handle that collided — widen and retry.
    }
  }
  throw new Error(
    `failed_to_insert_user:handle_exhausted:${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
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
