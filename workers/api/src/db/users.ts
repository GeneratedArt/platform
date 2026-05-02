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
