// FTS5-backed cross-entity search. The search_index virtual table
// (created in 0001) carries a `kind` discriminator (user / project /
// brief) so a single MATCH query can rank across all three; we then
// hydrate each ref_id back to its source row for the response.
//
// Query sanitisation: FTS5 has its own mini-syntax (`AND`, `OR`,
// `NOT`, column filters, `*` prefix, `"phrase"`, `^`). Letting the
// raw user query reach MATCH would (a) crash on unbalanced quotes
// and (b) let visitors break out of our intended ranking. We strip
// the input down to alphanumerics + spaces and reassemble it as
// `tok* tok* …` which is the safe equivalent of "any of these
// prefixes, ranked by bm25".

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

/// Lowercase, strip non-alphanumeric, emit prefix-OR query. Empty
/// input returns null so the caller can short-circuit with a 400.
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  // FTS5 prefix queries can't be longer than 64 chars per token in
  // practice — we cap to keep SQLite stable and pad each with `*`.
  return tokens
    .map((t) => t.slice(0, 32))
    .filter((t) => t.length >= 2)
    .map((t) => `${t}*`)
    .join(" OR ");
}

export interface SearchResults {
  projects: SearchHitProject[];
  artists: SearchHitUser[];
  briefs: SearchHitBrief[];
  query: string;
}

export async function searchAll(
  db: D1Database,
  q: string,
  kind: SearchKind,
  limit: number,
): Promise<SearchResults> {
  const ftsQuery = buildFtsQuery(q);
  const empty: SearchResults = {
    projects: [],
    artists: [],
    briefs: [],
    query: ftsQuery ?? "",
  };
  if (!ftsQuery) return empty;
  const cap = Math.max(1, Math.min(limit, PER_KIND_MAX));

  const wantProjects = kind === "all" || kind === "projects";
  const wantArtists = kind === "all" || kind === "artists";
  const wantBriefs = kind === "all" || kind === "briefs";

  const tasks: Promise<void>[] = [];
  if (wantProjects) {
    // bm25 returns negative numbers; lower is better. We surface the
    // absolute rank so a higher number in the API response is "more
    // relevant" — easier for the UI to reason about.
    tasks.push(
      db
        .prepare(
          `SELECT p.id, p.title, p.description, p.cover_url, p.status,
                  u.handle AS owner_handle,
                  bm25(search_index) AS r
           FROM search_index si
           JOIN projects p ON p.id = si.ref_id
           LEFT JOIN users u ON u.id = p.owner_id
           WHERE si.kind = 'project'
             AND si.search_index MATCH ?1
             AND p.status IN ('published','minted')
           ORDER BY r ASC
           LIMIT ?2`,
        )
        .bind(ftsQuery, cap)
        .all<{
          id: number;
          title: string;
          description: string | null;
          cover_url: string | null;
          status: string;
          owner_handle: string | null;
          r: number;
        }>()
        .then((res) => {
          empty.projects = (res.results ?? []).map((row) => ({
            kind: "project" as const,
            id: row.id,
            title: row.title,
            description: row.description,
            cover_url: row.cover_url,
            status: row.status,
            owner_handle: row.owner_handle,
            rank: -row.r,
          }));
        }),
    );
  }
  if (wantArtists) {
    tasks.push(
      db
        .prepare(
          `SELECT u.id, u.handle, u.display_name, u.avatar_url, u.bio,
                  bm25(search_index) AS r
           FROM search_index si
           JOIN users u ON u.id = si.ref_id
           WHERE si.kind = 'user'
             AND si.search_index MATCH ?1
           ORDER BY r ASC
           LIMIT ?2`,
        )
        .bind(ftsQuery, cap)
        .all<{
          id: number;
          handle: string;
          display_name: string | null;
          avatar_url: string | null;
          bio: string | null;
          r: number;
        }>()
        .then((res) => {
          empty.artists = (res.results ?? []).map((row) => ({
            kind: "user" as const,
            id: row.id,
            handle: row.handle,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            bio: row.bio,
            rank: -row.r,
          }));
        }),
    );
  }
  if (wantBriefs) {
    tasks.push(
      db
        .prepare(
          `SELECT b.id, b.title, b.body, b.status,
                  u.handle AS author_handle,
                  bm25(search_index) AS r
           FROM search_index si
           JOIN briefs b ON b.id = si.ref_id
           LEFT JOIN users u ON u.id = b.author_id
           WHERE si.kind = 'brief'
             AND si.search_index MATCH ?1
             AND b.status = 'open'
           ORDER BY r ASC
           LIMIT ?2`,
        )
        .bind(ftsQuery, cap)
        .all<{
          id: number;
          title: string;
          body: string;
          status: string;
          author_handle: string | null;
          r: number;
        }>()
        .then((res) => {
          empty.briefs = (res.results ?? []).map((row) => ({
            kind: "brief" as const,
            id: row.id,
            title: row.title,
            body_snippet: row.body
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 240),
            status: row.status,
            author_handle: row.author_handle,
            rank: -row.r,
          }));
        }),
    );
  }
  await Promise.all(tasks);
  return empty;
}

export const SEARCH_DEFAULTS = {
  PER_KIND_DEFAULT,
  PER_KIND_MAX,
};
