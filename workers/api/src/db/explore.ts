// Three SQL paths behind /v1/explore:
//   * recent    — created_at DESC, cursor pagination (created_at, id)
//   * trending  — 7-day weighted (mints*1.0 + views*0.1), offset pagination
//   * featured  — admin-curated `featured_projects.position ASC`
//
// All three only return rows whose `status` is one of the public
// statuses (`published`, `minted`); drafts and archives never leak.

import type { D1Database } from "@cloudflare/workers-types";
import type { ProjectRow } from "../types";

export interface ExploreRow extends ProjectRow {
  owner_handle: string | null;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  cover_capture_key: string | null;
  mint_count: number;
  view_count_7d?: number;
  trend_score?: number;
}

const PUBLIC_STATUS_CLAUSE = `p.status IN ('published','minted')`;

const BASE_SELECT = `
  p.*,
  u.handle      AS owner_handle,
  u.display_name AS owner_display_name,
  u.avatar_url   AS owner_avatar_url,
  (
    SELECT 'captures/' || c.project_id || '/' ||
           strftime('%s', 'now')   /* placeholder; real key joined below */
    FROM mints c WHERE c.project_id = p.id LIMIT 0
  ) AS cover_capture_key,
  (SELECT COUNT(*) FROM mints m WHERE m.project_id = p.id) AS mint_count
`;

// SQLite doesn't give us a clean way to inject the most-recent capture
// R2 key from inside a query (we'd need a separate captures table).
// We surface `cover_url` (set by the artist) as the primary cover and
// let the client fall back to a placeholder; the OG card pipeline
// resolves the actual capture via R2 list at render time. Keeping the
// SELECT shape stable lets us upgrade to a captures index later
// without changing this contract.

export interface RecentCursor {
  created_at: number;
  id: number;
}

const PAGE_DEFAULT = 24;
const PAGE_MAX = 60;

function clampLimit(n: number | undefined): number {
  if (!n || Number.isNaN(n)) return PAGE_DEFAULT;
  return Math.max(1, Math.min(n, PAGE_MAX));
}

export async function listRecent(
  db: D1Database,
  opts: { limit?: number; cursor?: RecentCursor | null },
): Promise<{ rows: ExploreRow[]; next: RecentCursor | null }> {
  const limit = clampLimit(opts.limit);
  const cur = opts.cursor;
  // Tuple comparison gives a stable sort + cursor without needing
  // a composite index — D1's SQLite handles the (created_at, id) pair.
  const sql = `
    SELECT ${BASE_SELECT}
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    WHERE ${PUBLIC_STATUS_CLAUSE}
      ${cur ? "AND (p.created_at < ?1 OR (p.created_at = ?1 AND p.id < ?2))" : ""}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${cur ? "?3" : "?1"}
  `;
  const stmt = cur
    ? db.prepare(sql).bind(cur.created_at, cur.id, limit + 1)
    : db.prepare(sql).bind(limit + 1);
  const result = await stmt.all<ExploreRow>();
  const rows = result.results ?? [];
  let next: RecentCursor | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    next = { created_at: last.created_at, id: last.id };
    rows.length = limit;
  }
  return { rows, next };
}

const TRENDING_WINDOW_SECONDS = 7 * 24 * 3600;

export async function listTrending(
  db: D1Database,
  opts: { limit?: number; offset?: number },
): Promise<{ rows: ExploreRow[]; next: number | null }> {
  const limit = clampLimit(opts.limit);
  const offset = Math.max(0, opts.offset ?? 0);
  const cutoff = Math.floor(Date.now() / 1000) - TRENDING_WINDOW_SECONDS;
  // Score weights:
  //   mints in window × 1.0  (a mint is the strongest signal we have)
  //   views in window × 0.1  (cheap, abundant; lots of weight would
  //                           let a single viewer game the ranking)
  //
  // Tie-break by created_at DESC then id DESC so the top of the
  // grid is deterministic across page loads even when scores are 0
  // (e.g. a fresh dev DB with no events).
  const sql = `
    SELECT ${BASE_SELECT},
           COALESCE(m7.cnt, 0) AS mint7,
           COALESCE(v7.cnt, 0) AS view_count_7d,
           (COALESCE(m7.cnt,0)*1.0 + COALESCE(v7.cnt,0)*0.1) AS trend_score
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt
      FROM mints WHERE minted_at >= ?1 AND project_id IS NOT NULL
      GROUP BY project_id
    ) m7 ON m7.project_id = p.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt
      FROM project_view_events WHERE ts >= ?1
      GROUP BY project_id
    ) v7 ON v7.project_id = p.id
    WHERE ${PUBLIC_STATUS_CLAUSE}
    ORDER BY trend_score DESC, p.created_at DESC, p.id DESC
    LIMIT ?2 OFFSET ?3
  `;
  const result = await db
    .prepare(sql)
    .bind(cutoff, limit + 1, offset)
    .all<ExploreRow>();
  const rows = result.results ?? [];
  let next: number | null = null;
  if (rows.length > limit) {
    next = offset + limit;
    rows.length = limit;
  }
  return { rows, next };
}

export async function listFeatured(
  db: D1Database,
  opts: { limit?: number; offset?: number },
): Promise<{ rows: ExploreRow[]; next: number | null }> {
  const limit = clampLimit(opts.limit);
  const offset = Math.max(0, opts.offset ?? 0);
  const sql = `
    SELECT ${BASE_SELECT},
           f.position AS feature_position,
           f.reason   AS feature_reason
    FROM featured_projects f
    JOIN projects p ON p.id = f.project_id
    JOIN users u    ON u.id = p.owner_id
    WHERE ${PUBLIC_STATUS_CLAUSE}
    ORDER BY f.position ASC, f.created_at DESC
    LIMIT ?1 OFFSET ?2
  `;
  const result = await db
    .prepare(sql)
    .bind(limit + 1, offset)
    .all<ExploreRow & { feature_position: number; feature_reason: string | null }>();
  const rows = result.results ?? [];
  let next: number | null = null;
  if (rows.length > limit) {
    next = offset + limit;
    rows.length = limit;
  }
  return { rows, next };
}

export const EXPLORE_DEFAULTS = { PAGE_DEFAULT, PAGE_MAX };
