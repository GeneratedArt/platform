import type { D1Database } from "@cloudflare/workers-types";
import type { ProjectRow } from "../types";

export interface ExploreRow extends ProjectRow {
  owner_handle: string | null;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  mint_count: number;
  view_count_7d?: number;
  trend_score?: number;
}

const PUBLIC_STATUS_CLAUSE = `p.status IN ('published','minted')`;

const BASE_SELECT = `
  p.*,
  u.handle       AS owner_handle,
  u.display_name AS owner_display_name,
  u.avatar_url   AS owner_avatar_url,
  (SELECT COUNT(*) FROM mints m WHERE m.project_id = p.id) AS mint_count
`;

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

/**
 * Task #18: trait filter. The repeated `&trait=name:value` query param
 * is parsed into a Map<name, value[]>. We translate that into one
 * EXISTS subquery per *name* (ANDed at the SQL level), each of which
 * tests `IN (...values)` (ORed within a name). Project rows survive
 * only if every name has at least one matching mint_traits row for
 * that project.
 */
export interface TraitFilter {
  name: string;
  values: string[];
}

function buildTraitFilterClause(
  traits: TraitFilter[],
  binds: unknown[],
): string {
  if (traits.length === 0) return "";
  const clauses: string[] = [];
  for (const t of traits) {
    const placeholders = t.values.map(() => "?").join(", ");
    clauses.push(
      `EXISTS (SELECT 1 FROM mint_traits mt
        WHERE mt.project_id = p.id
          AND mt.trait_name = ?
          AND mt.trait_value IN (${placeholders}))`,
    );
    binds.push(t.name, ...t.values);
  }
  return ` AND ${clauses.join(" AND ")}`;
}

export async function listRecent(
  db: D1Database,
  opts: {
    limit?: number;
    cursor?: RecentCursor | null;
    traits?: TraitFilter[];
  },
): Promise<{ rows: ExploreRow[]; next: RecentCursor | null }> {
  const limit = clampLimit(opts.limit);
  const cur = opts.cursor;
  const traits = opts.traits ?? [];
  // We must use positional placeholders because the cursor branch
  // already uses ?1/?2/?3. To keep the trait fan-out simple, we
  // switch to anonymous "?" binds across the whole query when traits
  // are present, which D1 binds positionally in order.
  if (traits.length > 0) {
    const binds: unknown[] = [];
    let cursorClause = "";
    if (cur) {
      cursorClause = "AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))";
      binds.push(cur.created_at, cur.created_at, cur.id);
    }
    const traitClause = buildTraitFilterClause(traits, binds);
    binds.push(limit + 1);
    const sql = `
      SELECT ${BASE_SELECT}
      FROM projects p
      JOIN users u ON u.id = p.owner_id
      WHERE ${PUBLIC_STATUS_CLAUSE}
        ${cursorClause}
        ${traitClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?
    `;
    const result = await db.prepare(sql).bind(...binds).all<ExploreRow>();
    const rows = result.results ?? [];
    let next: RecentCursor | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      next = { created_at: last.created_at, id: last.id };
      rows.length = limit;
    }
    return { rows, next };
  }
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
  // Score: mints*1.0 + views*0.1, tie-break by created_at then id.
  const sql = `
    SELECT ${BASE_SELECT},
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
