import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import {
  listRecent,
  listTrending,
  listFeatured,
  type ExploreRow,
  type TraitFilter,
} from "../db/explore";

/**
 * Parse the repeated `?trait=name:value` query param into a list of
 * `{ name, values: [...] }` groups. Same name appearing multiple
 * times collapses into one group with multiple values (OR within
 * a name); distinct names become distinct groups (AND across names).
 *
 * Defensive caps: at most 5 distinct names, at most 10 values per
 * name, name and value lengths matching the validator in
 * `db/mints.ts#normaliseTraits`. Anything that doesn't parse cleanly
 * is silently dropped — trait filters are a UX feature, not a
 * security boundary.
 */
function parseTraitFilters(raws: string[]): TraitFilter[] {
  const map = new Map<string, Set<string>>();
  for (const raw of raws) {
    const idx = raw.indexOf(":");
    if (idx <= 0 || idx === raw.length - 1) continue;
    const name = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (name.length === 0 || name.length > 32) continue;
    if (value.length === 0 || value.length > 64) continue;
    let set = map.get(name);
    if (!set) {
      if (map.size >= 5) continue;
      set = new Set<string>();
      map.set(name, set);
    }
    if (set.size >= 10) continue;
    set.add(value);
  }
  return Array.from(map.entries()).map(([name, set]) => ({
    name,
    values: Array.from(set),
  }));
}

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
  trend_score: number | null;
}

function captureBase(env: Env, reqUrl: string): string {
  if (env.CAPTURES_PUBLIC_BASE && env.CAPTURES_PUBLIC_BASE.length > 0) {
    return env.CAPTURES_PUBLIC_BASE.replace(/\/$/, "");
  }
  return new URL(reqUrl).origin;
}

function resolveCover(row: ExploreRow, capBase: string, w: number): string | null {
  if (row.last_capture_key) return `${capBase}/v1/captures/${row.last_capture_key}?w=${w}`;
  return row.cover_url;
}

function publicCard(row: ExploreRow, cover: string | null): PublicExploreCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    cover_url: cover,
    frozen_cid: row.frozen_cid,
    created_at: row.created_at,
    owner: {
      id: row.owner_id,
      handle: row.owner_handle,
      display_name: row.owner_display_name,
      avatar_url: row.owner_avatar_url,
    },
    mint_count: row.mint_count ?? 0,
    trend_score: typeof row.trend_score === "number" ? row.trend_score : null,
  };
}

function decodeCursor(raw: string | undefined): { created_at: number; id: number } | null {
  if (!raw) return null;
  try {
    const json = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const obj = JSON.parse(json) as { created_at?: unknown; id?: unknown };
    if (typeof obj.created_at !== "number" || typeof obj.id !== "number") return null;
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

const MAX_OFFSET = 600;

export async function exploreHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const tabRaw = (c.req.query("tab") || "recent") as Tab;
  const tab = ALLOWED_TABS.includes(tabRaw) ? tabRaw : "recent";
  const limit = parseInt(c.req.query("limit") || "", 10);
  const capBase = captureBase(c.env, c.req.url);

  let cards: PublicExploreCard[] = [];
  let nextCursor: string | null = null;

  // Repeated query params: Hono exposes `c.req.queries(name)` which
  // returns the full string[] (including dupes), so the same param
  // name appearing multiple times (e.g. ?trait=palette:warm&trait=palette:cool)
  // is preserved.
  const traitRaw = c.req.queries("trait") ?? [];
  const traits = parseTraitFilters(traitRaw);

  if (tab === "recent") {
    const cursor = decodeCursor(c.req.query("cursor"));
    const { rows, next } = await listRecent(c.env.DB, { limit, cursor, traits });
    cards = rows.map((r) => publicCard(r, resolveCover(r, capBase, 480)));
    nextCursor = next ? encodeCursor(next) : null;
  } else {
    const offsetRaw = parseInt(c.req.query("cursor") || "0", 10) || 0;
    if (offsetRaw < 0 || offsetRaw > MAX_OFFSET) {
      return c.json({ error: "cursor_out_of_range", max_offset: MAX_OFFSET }, 400);
    }
    const { rows, next } =
      tab === "trending"
        ? await listTrending(c.env.DB, { limit, offset: offsetRaw })
        : await listFeatured(c.env.DB, { limit, offset: offsetRaw });
    cards = rows.map((r) => publicCard(r, resolveCover(r, capBase, 480)));
    nextCursor = next === null || next > MAX_OFFSET ? null : String(next);
  }

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({
    tab,
    cards,
    next_cursor: nextCursor,
    traits: traits.length > 0 ? traits : undefined,
  });
}
