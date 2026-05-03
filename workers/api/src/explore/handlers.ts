import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import {
  listRecent,
  listTrending,
  listFeatured,
  type ExploreRow,
} from "../db/explore";

type Tab = "recent" | "trending" | "featured";
const ALLOWED_TABS: Tab[] = ["recent", "trending", "featured"];

interface PublicExploreCard {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  cover_url: string | null;
  frozen_cid: string | null;
  created_at: number;
  owner: {
    id: number;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
  mint_count: number;
  /// Only populated on the `trending` tab; null elsewhere so the
  /// schema stays uniform across tabs.
  trend_score: number | null;
}

function publicCard(row: ExploreRow): PublicExploreCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    cover_url: row.cover_url,
    frozen_cid: row.frozen_cid,
    created_at: row.created_at,
    owner: {
      id: row.owner_id,
      handle: row.owner_handle,
      display_name: row.owner_display_name,
      avatar_url: row.owner_avatar_url,
    },
    mint_count: row.mint_count ?? 0,
    trend_score:
      typeof row.trend_score === "number" ? row.trend_score : null,
  };
}

/// Cursor format:
///   recent   → base64url(JSON({ created_at, id }))
///   trending → numeric offset (small, infinite-scroll bound to ~5 pages)
///   featured → numeric offset
function decodeCursor(raw: string | undefined): {
  created_at: number;
  id: number;
} | null {
  if (!raw) return null;
  try {
    const json = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const obj = JSON.parse(json) as { created_at?: unknown; id?: unknown };
    if (
      typeof obj.created_at !== "number" ||
      typeof obj.id !== "number"
    ) {
      return null;
    }
    return { created_at: obj.created_at, id: obj.id };
  } catch {
    return null;
  }
}

function encodeCursor(cur: { created_at: number; id: number }): string {
  return btoa(JSON.stringify(cur))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * GET /v1/explore?tab={recent,trending,featured}&cursor=…&limit=N
 *
 * Public. Returns a uniform `{ tab, cards, next_cursor }` shape so
 * the UI can swap tabs without branching on response schema. Edge
 * cached for 60 s so a cold visitor on /explore lands in <100 ms
 * for repeat hits, but stale-while-revalidate keeps the grid fresh
 * within a five-minute boundary as new mints land.
 */
export async function exploreHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const tabRaw = (c.req.query("tab") || "recent") as Tab;
  const tab = ALLOWED_TABS.includes(tabRaw) ? tabRaw : "recent";
  const limit = parseInt(c.req.query("limit") || "", 10);

  let cards: PublicExploreCard[] = [];
  let nextCursor: string | null = null;

  if (tab === "recent") {
    const cursor = decodeCursor(c.req.query("cursor"));
    const { rows, next } = await listRecent(c.env.DB, {
      limit,
      cursor,
    });
    cards = rows.map(publicCard);
    nextCursor = next ? encodeCursor(next) : null;
  } else if (tab === "trending" || tab === "featured") {
    // Bounded offset pagination. We cap at MAX_OFFSET so a malicious
    // client can't ask for `?cursor=999999999` and force a full table
    // scan; trending especially does GROUP BY work that scales with
    // offset+limit, so a hard ceiling keeps p95 latency predictable.
    const MAX_OFFSET = 600; // ~25 pages of 24 cards — well past any human scroll
    const offsetRaw = parseInt(c.req.query("cursor") || "0", 10) || 0;
    if (offsetRaw < 0 || offsetRaw > MAX_OFFSET) {
      return c.json({ error: "cursor_out_of_range", max_offset: MAX_OFFSET }, 400);
    }
    const offset = offsetRaw;
    const { rows, next } =
      tab === "trending"
        ? await listTrending(c.env.DB, { limit, offset })
        : await listFeatured(c.env.DB, { limit, offset });
    cards = rows.map(publicCard);
    // If the next offset would exceed the cap, refuse to advertise it
    // so the client gracefully ends the feed rather than 400-ing on
    // its own next page.
    nextCursor = next === null || next > MAX_OFFSET ? null : String(next);
  } else {
    cards = [];
    nextCursor = null;
  }

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({ tab, cards, next_cursor: nextCursor });
}
