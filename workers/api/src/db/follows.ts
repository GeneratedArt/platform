import type { D1Database } from "@cloudflare/workers-types";

/**
 * `follows` is a junction table with a composite PK
 *   (follower_id, followed_id)
 * plus a CHECK that forbids self-follow. The DB rejects duplicates and
 * self-follows for us — handlers must surface those as no-ops or 400s
 * rather than 5xx.
 */

export async function followUser(
  db: D1Database,
  followerId: number,
  followedId: number,
): Promise<{ created: boolean }> {
  if (followerId === followedId) {
    throw new Error("self_follow_forbidden");
  }
  const now = Math.floor(Date.now() / 1000);
  // INSERT OR IGNORE so a double-tap on the Follow button is idempotent
  // — `changes()` tells us whether a new row landed so the handler can
  // distinguish "first follow" from "already following" if it ever
  // wants to (today both surface as 200 with the fresh count).
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .bind(followerId, followedId, now)
    .run();
  return { created: (result.meta?.changes ?? 0) > 0 };
}

export async function unfollowUser(
  db: D1Database,
  followerId: number,
  followedId: number,
): Promise<{ removed: boolean }> {
  const result = await db
    .prepare(
      `DELETE FROM follows WHERE follower_id = ? AND followed_id = ?`,
    )
    .bind(followerId, followedId)
    .run();
  return { removed: (result.meta?.changes ?? 0) > 0 };
}

export async function isFollowing(
  db: D1Database,
  followerId: number,
  followedId: number,
): Promise<boolean> {
  if (followerId === followedId) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM follows WHERE follower_id = ? AND followed_id = ?`,
    )
    .bind(followerId, followedId)
    .first<{ x: number }>();
  return !!row;
}

export interface FollowCounts {
  followers: number;
  following: number;
}

export async function getFollowCounts(
  db: D1Database,
  userId: number,
): Promise<FollowCounts> {
  // Single round-trip with two correlated subqueries — D1 batches scalar
  // subqueries efficiently and the index `idx_follows_followed` makes
  // the followed-side count an index-only scan.
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followed_id = ?) AS followers,
         (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following`,
    )
    .bind(userId, userId)
    .first<FollowCounts>();
  return row ?? { followers: 0, following: 0 };
}

export interface FollowEdgeUser {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  followed_at: number;
}

export async function listFollowers(
  db: D1Database,
  userId: number,
  limit = 50,
): Promise<FollowEdgeUser[]> {
  const result = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url, f.created_at AS followed_at
         FROM follows f
         JOIN users u ON u.id = f.follower_id
        WHERE f.followed_id = ?
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 200))
    .all<FollowEdgeUser>();
  return result.results ?? [];
}

export async function listFollowing(
  db: D1Database,
  userId: number,
  limit = 50,
): Promise<FollowEdgeUser[]> {
  const result = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url, f.created_at AS followed_at
         FROM follows f
         JOIN users u ON u.id = f.followed_id
        WHERE f.follower_id = ?
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 200))
    .all<FollowEdgeUser>();
  return result.results ?? [];
}
