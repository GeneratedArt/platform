// Single FTS5 ranking query across users/projects/briefs, then
// per-kind hydration. Query sanitisation: alphanum tokens only,
// reassembled as `tok* OR tok* …` so users can't inject FTS5 operators.

import type { D1Database } from "@cloudflare/workers-types";

export interface SearchHitProject {
  kind: "project";
  id: number;
  title: string;
  description: string | null;
  cover_url: string | null;
  status: string;
  owner_handle: string | null;
  rank: number;
}
export interface SearchHitUser {
  kind: "user";
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  rank: number;
}
export interface SearchHitBrief {
  kind: "brief";
  id: number;
  title: string;
  body_snippet: string;
  status: string;
  author_handle: string | null;
  rank: number;
}
export type SearchHit = SearchHitProject | SearchHitUser | SearchHitBrief;

export type SearchKind = "all" | "projects" | "artists" | "briefs";

const PER_KIND_DEFAULT = 10;
const PER_KIND_MAX = 25;

export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  const safe = tokens
    .map((t) => t.slice(0, 32))
    .filter((t) => t.length >= 2)
    .map((t) => `${t}*`);
  if (safe.length === 0) return null;
  return safe.join(" OR ");
}

export interface SearchResults {
  projects: SearchHitProject[];
  artists: SearchHitUser[];
  briefs: SearchHitBrief[];
  query: string;
}

interface RankedRef {
  kind: "user" | "project" | "brief";
  ref_id: number;
  rank: number;
}

export async function searchAll(
  db: D1Database,
  q: string,
  kind: SearchKind,
  limit: number,
): Promise<SearchResults> {
  const ftsQuery = buildFtsQuery(q);
  const empty: SearchResults = { projects: [], artists: [], briefs: [], query: ftsQuery ?? "" };
  if (!ftsQuery) return empty;

  const cap = Math.max(1, Math.min(limit, PER_KIND_MAX));
  // One ranking pass over all kinds. We over-fetch (cap*3) so each
  // grouped list still has up to `cap` rows even when one kind
  // dominates the top of the bm25 ordering.
  const ranked = await db
    .prepare(
      `SELECT kind, ref_id, bm25(search_index) AS r
       FROM search_index
       WHERE search_index MATCH ?1
       ORDER BY r ASC
       LIMIT ?2`,
    )
    .bind(ftsQuery, cap * 3)
    .all<{ kind: string; ref_id: number; r: number }>();

  const refs: RankedRef[] = (ranked.results ?? [])
    .filter((row) => row.kind === "user" || row.kind === "project" || row.kind === "brief")
    .map((row) => ({
      kind: row.kind as RankedRef["kind"],
      ref_id: row.ref_id,
      rank: -row.r,
    }));

  const wantProjects = kind === "all" || kind === "projects";
  const wantArtists = kind === "all" || kind === "artists";
  const wantBriefs = kind === "all" || kind === "briefs";

  const projectRefs = wantProjects ? refs.filter((r) => r.kind === "project").slice(0, cap) : [];
  const userRefs = wantArtists ? refs.filter((r) => r.kind === "user").slice(0, cap) : [];
  const briefRefs = wantBriefs ? refs.filter((r) => r.kind === "brief").slice(0, cap) : [];

  const tasks: Promise<void>[] = [];

  if (projectRefs.length > 0) {
    const ids = projectRefs.map((r) => r.ref_id);
    const placeholders = ids.map(() => "?").join(",");
    tasks.push(
      db
        .prepare(
          `SELECT p.id, p.title, p.description, p.cover_url, p.status,
                  u.handle AS owner_handle
           FROM projects p
           LEFT JOIN users u ON u.id = p.owner_id
           WHERE p.id IN (${placeholders})
             AND p.status IN ('published','minted')`,
        )
        .bind(...ids)
        .all<{
          id: number;
          title: string;
          description: string | null;
          cover_url: string | null;
          status: string;
          owner_handle: string | null;
        }>()
        .then((res) => {
          const byId = new Map((res.results ?? []).map((row) => [row.id, row]));
          empty.projects = projectRefs
            .map((ref) => {
              const row = byId.get(ref.ref_id);
              if (!row) return null;
              return {
                kind: "project" as const,
                id: row.id,
                title: row.title,
                description: row.description,
                cover_url: row.cover_url,
                status: row.status,
                owner_handle: row.owner_handle,
                rank: ref.rank,
              };
            })
            .filter((x): x is SearchHitProject => x !== null);
        }),
    );
  }

  if (userRefs.length > 0) {
    const ids = userRefs.map((r) => r.ref_id);
    const placeholders = ids.map(() => "?").join(",");
    tasks.push(
      db
        .prepare(
          `SELECT id, handle, display_name, avatar_url, bio
           FROM users WHERE id IN (${placeholders})`,
        )
        .bind(...ids)
        .all<{
          id: number;
          handle: string;
          display_name: string | null;
          avatar_url: string | null;
          bio: string | null;
        }>()
        .then((res) => {
          const byId = new Map((res.results ?? []).map((row) => [row.id, row]));
          empty.artists = userRefs
            .map((ref) => {
              const row = byId.get(ref.ref_id);
              if (!row) return null;
              return {
                kind: "user" as const,
                id: row.id,
                handle: row.handle,
                display_name: row.display_name,
                avatar_url: row.avatar_url,
                bio: row.bio,
                rank: ref.rank,
              };
            })
            .filter((x): x is SearchHitUser => x !== null);
        }),
    );
  }

  if (briefRefs.length > 0) {
    const ids = briefRefs.map((r) => r.ref_id);
    const placeholders = ids.map(() => "?").join(",");
    tasks.push(
      db
        .prepare(
          `SELECT b.id, b.title, b.body, b.status,
                  u.handle AS author_handle
           FROM briefs b
           LEFT JOIN users u ON u.id = b.author_id
           WHERE b.id IN (${placeholders}) AND b.status = 'open'`,
        )
        .bind(...ids)
        .all<{
          id: number;
          title: string;
          body: string;
          status: string;
          author_handle: string | null;
        }>()
        .then((res) => {
          const byId = new Map((res.results ?? []).map((row) => [row.id, row]));
          empty.briefs = briefRefs
            .map((ref) => {
              const row = byId.get(ref.ref_id);
              if (!row) return null;
              return {
                kind: "brief" as const,
                id: row.id,
                title: row.title,
                body_snippet: row.body.replace(/\s+/g, " ").trim().slice(0, 240),
                status: row.status,
                author_handle: row.author_handle,
                rank: ref.rank,
              };
            })
            .filter((x): x is SearchHitBrief => x !== null);
        }),
    );
  }

  await Promise.all(tasks);
  return empty;
}

export const SEARCH_DEFAULTS = { PER_KIND_DEFAULT, PER_KIND_MAX };
