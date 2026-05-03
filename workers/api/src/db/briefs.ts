import type { D1Database } from "@cloudflare/workers-types";

export const INDUSTRIES = [
  "textile",
  "fashion",
  "architecture",
  "product",
  "gallery",
  "collab",
  "other",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const BRIEF_STATUSES = ["open", "closed", "archived"] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export interface BriefRow {
  id: number;
  author_id: number;
  title: string;
  body: string;
  reward: string | null;
  status: BriefStatus;
  industry: Industry;
  budget: string | null;
  deadline: number | null;
  created_at: number;
  updated_at: number;
}

export interface BriefAuthor {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface CreateBriefInput {
  authorId: number;
  title: string;
  body: string;
  industry: Industry;
  budget: string | null;
  deadline: number | null;
}

export async function insertBrief(
  db: D1Database,
  input: CreateBriefInput,
): Promise<BriefRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO briefs
         (author_id, title, body, industry, budget, deadline, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
       RETURNING *`,
    )
    .bind(
      input.authorId,
      input.title,
      input.body,
      input.industry,
      input.budget,
      input.deadline,
      now,
      now,
    )
    .first<BriefRow>();
  if (!row) throw new Error("brief_insert_failed");
  return row;
}

export async function getBriefById(
  db: D1Database,
  id: number,
): Promise<BriefRow | null> {
  return db
    .prepare("SELECT * FROM briefs WHERE id = ?")
    .bind(id)
    .first<BriefRow>();
}

export async function getBriefAuthor(
  db: D1Database,
  authorId: number,
): Promise<BriefAuthor | null> {
  return db
    .prepare(
      "SELECT id, handle, display_name, avatar_url FROM users WHERE id = ?",
    )
    .bind(authorId)
    .first<BriefAuthor>();
}

export interface ListBriefsOptions {
  industry?: Industry;
  status?: BriefStatus;
  limit: number;
  before?: number; // pagination cursor: created_at, exclusive
}

export interface BriefListItem extends BriefRow {
  author_handle: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
}

export async function listBriefs(
  db: D1Database,
  opts: ListBriefsOptions,
): Promise<BriefListItem[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  where.push("b.status = ?");
  binds.push(opts.status ?? "open");
  if (opts.industry) {
    where.push("b.industry = ?");
    binds.push(opts.industry);
  }
  if (opts.before !== undefined) {
    where.push("b.created_at < ?");
    binds.push(opts.before);
  }
  const sql = `
    SELECT b.*,
           u.handle       AS author_handle,
           u.display_name AS author_display_name,
           u.avatar_url   AS author_avatar_url
      FROM briefs b
      JOIN users  u ON u.id = b.author_id
     WHERE ${where.join(" AND ")}
     ORDER BY b.created_at DESC
     LIMIT ?
  `;
  binds.push(opts.limit);
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<BriefListItem>();
  return res.results ?? [];
}
