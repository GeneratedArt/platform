import type { D1Database } from "@cloudflare/workers-types";

const DEDUPE_WINDOW_SECONDS = 30 * 60;

async function hashIp(projectId: number, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${projectId}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export async function recordProjectView(
  db: D1Database,
  projectId: number,
  ip: string,
): Promise<void> {
  const ipHash = await hashIp(projectId, ip);
  const now = Math.floor(Date.now() / 1000);
  const recent = await db
    .prepare(
      `SELECT 1 FROM project_view_events
       WHERE project_id = ? AND ip_hash = ? AND ts >= ?
       LIMIT 1`,
    )
    .bind(projectId, ipHash, now - DEDUPE_WINDOW_SECONDS)
    .first();
  if (recent) return;
  await db
    .prepare(
      `INSERT INTO project_view_events (project_id, ts, ip_hash)
       VALUES (?, ?, ?)`,
    )
    .bind(projectId, now, ipHash)
    .run();
}

export async function pruneOldViewEvents(
  db: D1Database,
  olderThanSeconds: number = 30 * 24 * 3600,
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  await db
    .prepare(`DELETE FROM project_view_events WHERE ts < ?`)
    .bind(cutoff)
    .run();
}

// ---------------------------------------------------------------------------
// Activity feed + notifications
// ---------------------------------------------------------------------------

export type EventKind =
  | "commit"
  | "freeze"
  | "mint"
  | "follow"
  | "brief_posted"
  // Notification kinds emitted by future application/curation handlers.
  // The `applications` table exists since 0001_init.sql; the route that
  // creates a row should call recordBriefApplicationEvent() to notify
  // the brief author. The `featured_projects` table exists since
  // 0009_discovery_search.sql; whatever curator path inserts a row
  // should call recordFeaturedEvent() to notify the project owner.
  | "brief_application"
  | "featured";

export type EventTargetKind = "project" | "user" | "brief" | "frozen" | "mint";

export interface RecordEventInput {
  kind: EventKind;
  actor_id: number;
  target_kind?: EventTargetKind | null;
  target_id?: number | null;
  /** NULL for public-feed events; the receiving user's id for notifications. */
  recipient_id?: number | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Best-effort writer for the activity feed. Callers must wrap this in
 * try/catch and never let a write failure abort the primary action that
 * produced the event — a missing feed row is recoverable, a failed
 * commit/freeze/mint is not.
 */
export async function recordEvent(
  db: D1Database,
  input: RecordEventInput,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO events
         (kind, actor_id, target_kind, target_id, recipient_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.kind,
      input.actor_id,
      input.target_kind ?? null,
      input.target_id ?? null,
      input.recipient_id ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      now,
    )
    .run();
}

/**
 * Notify a brief author that someone applied to their brief. Call
 * from the (future) POST /v1/briefs/:id/applications handler after
 * the application row is committed.
 */
export async function recordBriefApplicationEvent(
  db: D1Database,
  args: {
    applicantId: number;
    briefAuthorId: number;
    briefId: number;
    briefTitle?: string | null;
    applicationId?: number | null;
  },
): Promise<void> {
  await recordEvent(db, {
    kind: "brief_application",
    actor_id: args.applicantId,
    target_kind: "brief",
    target_id: args.briefId,
    recipient_id: args.briefAuthorId,
    payload: {
      brief_id: args.briefId,
      title: args.briefTitle ?? null,
      application_id: args.applicationId ?? null,
    },
  });
}

/**
 * Notify a project owner that their project was featured. Call from
 * the (future) curator-only handler after a row is inserted into
 * `featured_projects`.
 */
export async function recordFeaturedEvent(
  db: D1Database,
  args: {
    curatorId: number;
    projectOwnerId: number;
    projectId: number;
    projectTitle?: string | null;
  },
): Promise<void> {
  await recordEvent(db, {
    kind: "featured",
    actor_id: args.curatorId,
    target_kind: "project",
    target_id: args.projectId,
    recipient_id: args.projectOwnerId,
    payload: {
      project_id: args.projectId,
      title: args.projectTitle ?? null,
    },
  });
}

export interface FeedRow {
  id: number;
  kind: string;
  actor_id: number;
  actor_handle: string;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  target_kind: string | null;
  target_id: number | null;
  payload_json: string | null;
  created_at: number;
  read_at: number | null;
}

export interface FeedCursor {
  created_at: number;
  id: number;
}

function decodeCursor(raw: string | null): FeedCursor | null {
  if (!raw) return null;
  // Expected format: "<created_at>:<id>". Both ints, base-10. Anything
  // off-shape becomes null so a malformed param 400s in the handler
  // rather than poisoning the SQL with NaN.
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const ts = parseInt(parts[0]!, 10);
  const id = parseInt(parts[1]!, 10);
  if (!Number.isFinite(ts) || !Number.isFinite(id) || ts < 0 || id < 0) {
    return null;
  }
  return { created_at: ts, id };
}

export function parseFeedCursor(raw: string | null): FeedCursor | null {
  return decodeCursor(raw);
}

export function encodeFeedCursor(c: FeedCursor): string {
  return `${c.created_at}:${c.id}`;
}

/**
 * Reverse-chronological feed of events whose actor the viewer follows.
 * `recipient_id IS NULL` filters out direct notifications so the feed
 * is purely public-broadcast events. Page size is hard-capped by the
 * caller; this helper just executes the (limit+1) keyset query.
 */
export async function listFollowFeed(
  db: D1Database,
  viewerId: number,
  limit: number,
  cursor: FeedCursor | null,
): Promise<FeedRow[]> {
  const cursorClause = cursor
    ? "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
    : "";
  const sql =
    `SELECT e.id, e.kind, e.actor_id,
            u.handle        AS actor_handle,
            u.display_name  AS actor_display_name,
            u.avatar_url    AS actor_avatar_url,
            e.target_kind, e.target_id, e.payload_json,
            e.created_at, e.read_at
       FROM events e
       JOIN follows f ON f.followed_id = e.actor_id
       JOIN users u   ON u.id = e.actor_id
      WHERE f.follower_id = ?
        AND e.recipient_id IS NULL
        ${cursorClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`;

  const stmt = db.prepare(sql);
  const bound = cursor
    ? stmt.bind(viewerId, cursor.created_at, cursor.created_at, cursor.id, limit)
    : stmt.bind(viewerId, limit);
  const { results } = await bound.all<FeedRow>();
  return results ?? [];
}

/**
 * Notifications addressed to the viewer (recipient_id = me). Same
 * keyset shape as the feed.
 */
export async function listNotifications(
  db: D1Database,
  viewerId: number,
  limit: number,
  cursor: FeedCursor | null,
): Promise<FeedRow[]> {
  const cursorClause = cursor
    ? "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
    : "";
  const sql =
    `SELECT e.id, e.kind, e.actor_id,
            u.handle        AS actor_handle,
            u.display_name  AS actor_display_name,
            u.avatar_url    AS actor_avatar_url,
            e.target_kind, e.target_id, e.payload_json,
            e.created_at, e.read_at
       FROM events e
       JOIN users u ON u.id = e.actor_id
      WHERE e.recipient_id = ?
        ${cursorClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`;

  const stmt = db.prepare(sql);
  const bound = cursor
    ? stmt.bind(viewerId, cursor.created_at, cursor.created_at, cursor.id, limit)
    : stmt.bind(viewerId, limit);
  const { results } = await bound.all<FeedRow>();
  return results ?? [];
}

/**
 * Unread count for the bell badge. Backed by the partial index
 * `idx_events_unread` so it stays O(unread), not O(history).
 */
export async function unreadNotificationCount(
  db: D1Database,
  viewerId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE recipient_id = ? AND read_at IS NULL`,
    )
    .bind(viewerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Mark a list of notifications (or all of the viewer's unread ones if
 * `ids` is empty) as read. Returns the number of rows updated.
 *
 * IDs are filtered server-side by `recipient_id = viewerId` so a
 * malicious client can't mark someone else's notifications read.
 */
export async function markNotificationsRead(
  db: D1Database,
  viewerId: number,
  ids: number[],
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  if (ids.length === 0) {
    const r = await db
      .prepare(
        `UPDATE events SET read_at = ?
          WHERE recipient_id = ? AND read_at IS NULL`,
      )
      .bind(now, viewerId)
      .run();
    return r.meta?.changes ?? 0;
  }
  // Cap to keep SQL parameter counts sane.
  const capped = ids.slice(0, 200);
  const placeholders = capped.map(() => "?").join(",");
  const r = await db
    .prepare(
      `UPDATE events SET read_at = ?
        WHERE recipient_id = ?
          AND read_at IS NULL
          AND id IN (${placeholders})`,
    )
    .bind(now, viewerId, ...capped)
    .run();
  return r.meta?.changes ?? 0;
}

/**
 * Public shape of an event row sent to the client. Decodes the payload
 * JSON eagerly and drops the raw column so the client doesn't have to
 * re-parse on render.
 */
export interface PublicEvent {
  id: number;
  kind: string;
  actor: {
    id: number;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  target_kind: string | null;
  target_id: number | null;
  payload: Record<string, unknown> | null;
  created_at: number;
  read_at: number | null;
}

export function publicEvent(row: FeedRow): PublicEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    actor: {
      id: row.actor_id,
      handle: row.actor_handle,
      display_name: row.actor_display_name,
      avatar_url: row.actor_avatar_url,
    },
    target_kind: row.target_kind,
    target_id: row.target_id,
    payload,
    created_at: row.created_at,
    read_at: row.read_at,
  };
}
