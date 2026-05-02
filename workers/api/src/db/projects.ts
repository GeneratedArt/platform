import type { ProjectRow } from "../types";

export type ProjectStatus = "draft" | "published" | "minted" | "archived";
export type ProjectEngine = "p5" | "three" | "shader" | "canvas";

export const ENGINES: ProjectEngine[] = ["p5", "three", "shader", "canvas"];
export const STATUSES: ProjectStatus[] = [
  "draft",
  "published",
  "minted",
  "archived",
];

interface CreateProjectInput {
  ownerId: number;
  slug: string;
  title: string;
  description: string | null;
  engine: ProjectEngine;
  license: string;
  repoUrl: string;
  repoFull: string;
}

export async function insertProject(
  db: D1Database,
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO projects
         (owner_id, slug, title, description, engine, license, repo_url, repo_full, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       RETURNING *`,
    )
    .bind(
      input.ownerId,
      input.slug,
      input.title,
      input.description,
      input.engine,
      input.license,
      input.repoUrl,
      input.repoFull,
      now,
      now,
    )
    .first<ProjectRow>();
  if (!row) throw new Error("project_insert_failed");
  return row;
}

export async function getProjectById(
  db: D1Database,
  id: number,
): Promise<ProjectRow | null> {
  return db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .bind(id)
    .first<ProjectRow>();
}

export async function listProjectsByOwner(
  db: D1Database,
  ownerId: number,
): Promise<ProjectRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC",
    )
    .bind(ownerId)
    .all<ProjectRow>();
  return result.results ?? [];
}

export async function listProjectsByHandle(
  db: D1Database,
  handle: string,
): Promise<ProjectRow[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM projects p
       JOIN users u ON u.id = p.owner_id
       WHERE u.handle = ?
       ORDER BY p.updated_at DESC`,
    )
    .bind(handle)
    .all<ProjectRow>();
  return result.results ?? [];
}

interface UpdatableFields {
  title?: string;
  description?: string | null;
  status?: ProjectStatus;
  cover_url?: string | null;
}

export async function updateProject(
  db: D1Database,
  id: number,
  patch: UpdatableFields,
): Promise<ProjectRow | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.cover_url !== undefined) {
    sets.push("cover_url = ?");
    binds.push(patch.cover_url);
  }
  if (sets.length === 0) {
    return getProjectById(db, id);
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(id);
  const sql = `UPDATE projects SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(sql).bind(...binds).first<ProjectRow>();
}

export function publicProject(p: ProjectRow) {
  return {
    id: p.id,
    owner_id: p.owner_id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    engine: p.engine,
    license: p.license,
    status: p.status,
    repo_url: p.repo_url,
    repo_full: p.repo_full,
    cover_url: p.cover_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
