import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import {
  encodeFeedCursor,
  listFollowFeed,
  listNotifications,
  markNotificationsRead,
  parseFeedCursor,
  publicEvent,
  unreadNotificationCount,
} from "../db/events";
import { listTrending } from "../db/explore";

const PAGE_DEFAULT = 25;
const PAGE_MAX = 50;
const SUGGEST_COUNT = 3;

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

function parseLimit(c: Context): number | { error: Response } {
  const raw = new URL(c.req.url).searchParams.get("limit");
  if (!raw) return PAGE_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > PAGE_MAX) {
    return { error: badRequest(c, "invalid_limit", { max: PAGE_MAX }) };
  }
  return n;
}

/**
 * GET /v1/feed?cursor=<created_at>:<id>&limit=
 *
 * Auth required. Returns the viewer's reverse-chronological follow
 * feed plus, when no events are available (typical on first sign-in),
 * a small set of suggested artists to follow drawn from /explore
 * trending. The feed cap is 50 rows per page.
 */
export async function feedHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const limitOrErr = parseLimit(c);
  if (typeof limitOrErr !== "number") return limitOrErr.error;
  const limit = limitOrErr;

  const cursorRaw = new URL(c.req.url).searchParams.get("cursor");
  const cursor = parseFeedCursor(cursorRaw);
  if (cursorRaw && !cursor) return badRequest(c, "invalid_cursor");

  // limit+1 to detect whether more rows exist without a separate count query.
  const rows = await listFollowFeed(c.env.DB, session.uid, limit + 1, cursor);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map(publicEvent);
  const last = page[page.length - 1];
  const next_cursor = hasMore && last
    ? encodeFeedCursor({ created_at: last.created_at, id: last.id })
    : null;

  // Empty-state suggestions: only on the first page (no cursor) when
  // the feed has nothing to show. Drawn from the trending users list
  // so the recommendations are consistent with /explore.
  let suggestions: Array<{
    id: number;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
  }> = [];
  if (!cursor && events.length === 0) {
    // Surface the artists behind the top trending projects as a
    // first-touch follow list. We pull more than we need and dedupe
    // by owner so a single artist with two trending projects
    // doesn't fill the slate.
    const trending = await listTrending(c.env.DB, { limit: SUGGEST_COUNT * 4 });
    const seen = new Set<number>();
    seen.add(session.uid);
    for (const row of trending.rows) {
      if (suggestions.length >= SUGGEST_COUNT) break;
      if (seen.has(row.owner_id)) continue;
      seen.add(row.owner_id);
      suggestions.push({
        id: row.owner_id,
        handle: row.owner_handle ?? "",
        display_name: row.owner_display_name ?? null,
        avatar_url: row.owner_avatar_url ?? null,
      });
    }
  }

  // Personal feed — must never be cached at the edge.
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json({ events, next_cursor, suggestions });
}

/**
 * GET /v1/notifications?cursor=&limit=
 *
 * Auth required. Returns notifications addressed to the viewer
 * (recipient_id = me) plus the current unread count for the bell
 * badge.
 */
export async function notificationsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const limitOrErr = parseLimit(c);
  if (typeof limitOrErr !== "number") return limitOrErr.error;
  const limit = limitOrErr;

  const cursorRaw = new URL(c.req.url).searchParams.get("cursor");
  const cursor = parseFeedCursor(cursorRaw);
  if (cursorRaw && !cursor) return badRequest(c, "invalid_cursor");

  const rows = await listNotifications(c.env.DB, session.uid, limit + 1, cursor);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(publicEvent);
  const last = page[page.length - 1];
  const next_cursor = hasMore && last
    ? encodeFeedCursor({ created_at: last.created_at, id: last.id })
    : null;
  const unread = await unreadNotificationCount(c.env.DB, session.uid);

  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json({ notifications: items, next_cursor, unread });
}

interface ReadBody {
  ids?: unknown;
  all?: unknown;
}

/**
 * POST /v1/notifications/read
 *
 * Body: `{ ids: number[] }` to mark specific rows read, or
 *       `{ all: true }` to clear the badge. Returns the new unread
 *       count and the number of rows actually flipped.
 */
export async function markNotificationsReadHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  let body: ReadBody = {};
  try {
    body = await c.req.json<ReadBody>();
  } catch {
    // Allow empty body — equivalent to `{ all: true }` so the client
    // can `fetch(url, {method:'POST'})` without a payload.
    body = { all: true };
  }

  let ids: number[] = [];
  const all = body.all === true;
  if (!all) {
    if (!Array.isArray(body.ids)) return badRequest(c, "invalid_ids");
    for (const raw of body.ids) {
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 1) return badRequest(c, "invalid_id");
      ids.push(n);
    }
  }

  const updated = await markNotificationsRead(c.env.DB, session.uid, ids);
  const unread = await unreadNotificationCount(c.env.DB, session.uid);
  c.header("Cache-Control", "private, no-store");
  return c.json({ updated, unread });
}
