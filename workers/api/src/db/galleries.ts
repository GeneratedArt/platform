import type { D1Database } from "@cloudflare/workers-types";

export interface GalleryRow {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  body_md: string | null;
  curator_id: number | null;
  cover_url: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GalleryCurator {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  is_curator: number;
}

export interface GalleryListItem extends GalleryRow {
  curator_handle: string | null;
  curator_display_name: string | null;
  curator_avatar_url: string | null;
  project_count: number;
}

export interface GalleryProject {
  project_id: number;
  position: number;
  created_at: number;
  // Joined project + owner fields used by the public gallery page +
  // the project-card grid.
  slug: string;
  title: string;
  description: string | null;
  status: string;
  cover_url: string | null;
  last_capture_key: string | null;
  frozen_cid: string | null;
  owner_id: number;
  owner_handle: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
}

export interface CreateGalleryInput {
  curatorId: number;
  slug: string;
  title: string;
  description: string | null;
  bodyMd: string | null;
  coverUrl: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  startsAt: number | null;
  endsAt: number | null;
}

export async function insertGallery(
  db: D1Database,
  input: CreateGalleryInput,
): Promise<GalleryRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO galleries
         (slug, title, description, body_md, curator_id, cover_url,
          location, lat, lon, starts_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.slug,
      input.title,
      input.description,
      input.bodyMd,
      input.curatorId,
      input.coverUrl,
      input.location,
      input.lat,
      input.lon,
      input.startsAt,
      input.endsAt,
      now,
      now,
    )
    .first<GalleryRow>();
  if (!row) throw new Error("gallery_insert_failed");
  return row;
}

export async function getGalleryBySlug(
  db: D1Database,
  slug: string,
): Promise<GalleryRow | null> {
  return db
    .prepare("SELECT * FROM galleries WHERE slug = ?")
    .bind(slug)
    .first<GalleryRow>();
}

export async function getGalleryCurator(
  db: D1Database,
  curatorId: number,
): Promise<GalleryCurator | null> {
  return db
    .prepare(
      `SELECT id, handle, display_name, avatar_url, is_curator
       FROM users WHERE id = ?`,
    )
    .bind(curatorId)
    .first<GalleryCurator>();
}

export interface ListGalleriesOptions {
  curatorId?: number;
  limit: number;
  before?: number;
}

export async function listGalleries(
  db: D1Database,
  opts: ListGalleriesOptions,
): Promise<GalleryListItem[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.curatorId !== undefined) {
    where.push("g.curator_id = ?");
    binds.push(opts.curatorId);
  }
  if (opts.before !== undefined) {
    where.push("g.created_at < ?");
    binds.push(opts.before);
  }
  const sql = `
    SELECT g.*,
           u.handle       AS curator_handle,
           u.display_name AS curator_display_name,
           u.avatar_url   AS curator_avatar_url,
           (SELECT COUNT(*) FROM gallery_projects gp
              WHERE gp.gallery_id = g.id) AS project_count
    FROM galleries g
    LEFT JOIN users u ON u.id = g.curator_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY g.created_at DESC, g.id DESC
    LIMIT ?
  `;
  binds.push(opts.limit);
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<GalleryListItem>();
  return res.results ?? [];
}

/**
 * Reverse lookup for the "Curated by" badge on /p/?id=N. Returns the
 * (slim) galleries that include the given project, newest-first.
 * Only galleries with a non-null curator are surfaced — a gallery
 * whose curator was deleted (curator_id NULL via ON DELETE SET NULL)
 * is hidden from the badge so we don't render a broken handle link.
 */
export async function listGalleriesForProject(
  db: D1Database,
  projectId: number,
  limit = 10,
): Promise<
  Array<{
    id: number;
    slug: string;
    title: string;
    curator_handle: string;
    curator_display_name: string | null;
    added_at: number;
  }>
> {
  const res = await db
    .prepare(
      `SELECT g.id, g.slug, g.title,
              u.handle       AS curator_handle,
              u.display_name AS curator_display_name,
              gp.created_at  AS added_at
         FROM gallery_projects gp
         JOIN galleries g ON g.id = gp.gallery_id
         JOIN users u     ON u.id = g.curator_id
        WHERE gp.project_id = ?
        ORDER BY gp.created_at DESC, gp.gallery_id DESC
        LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<{
      id: number;
      slug: string;
      title: string;
      curator_handle: string;
      curator_display_name: string | null;
      added_at: number;
    }>();
  return res.results ?? [];
}

export async function listProjectsInGallery(
  db: D1Database,
  galleryId: number,
): Promise<GalleryProject[]> {
  const res = await db
    .prepare(
      `SELECT gp.project_id, gp.position, gp.created_at,
              p.slug, p.title, p.description, p.status, p.cover_url,
              p.last_capture_key, p.frozen_cid, p.owner_id,
              u.handle       AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar_url   AS owner_avatar_url
         FROM gallery_projects gp
         JOIN projects p ON p.id = gp.project_id
         JOIN users u    ON u.id = p.owner_id
        WHERE gp.gallery_id = ?
          AND p.status IN ('published','minted')
        ORDER BY gp.position ASC, gp.created_at ASC`,
    )
    .bind(galleryId)
    .all<GalleryProject>();
  return res.results ?? [];
}

export interface GalleryPatch {
  title?: string;
  description?: string | null;
  bodyMd?: string | null;
  coverUrl?: string | null;
  location?: string | null;
  lat?: number | null;
  lon?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
}

export async function updateGallery(
  db: D1Database,
  id: number,
  patch: GalleryPatch,
): Promise<GalleryRow | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const map: Array<[keyof GalleryPatch, string]> = [
    ["title", "title"],
    ["description", "description"],
    ["bodyMd", "body_md"],
    ["coverUrl", "cover_url"],
    ["location", "location"],
    ["lat", "lat"],
    ["lon", "lon"],
    ["startsAt", "starts_at"],
    ["endsAt", "ends_at"],
  ];
  for (const [k, col] of map) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(patch[k] as unknown);
    }
  }
  if (sets.length === 0) {
    return db
      .prepare("SELECT * FROM galleries WHERE id = ?")
      .bind(id)
      .first<GalleryRow>();
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(id);
  return db
    .prepare(`UPDATE galleries SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...binds)
    .first<GalleryRow>();
}

/**
 * Idempotent add. Returns `{ inserted: true }` only when a new row
 * was created — callers use that to decide whether to emit a
 * `gallery_added` event so re-adding a project doesn't double-notify
 * the artist.
 */
export async function addProjectToGallery(
  db: D1Database,
  galleryId: number,
  projectId: number,
  position: number,
): Promise<{ inserted: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO gallery_projects
         (gallery_id, project_id, position, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(galleryId, projectId, position, now)
    .run();
  // D1's `meta.changes` reports rows actually written. INSERT OR
  // IGNORE on a duplicate PK reports 0 changes.
  const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  return { inserted: changes > 0 };
}

export async function removeProjectFromGallery(
  db: D1Database,
  galleryId: number,
  projectId: number,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM gallery_projects WHERE gallery_id = ? AND project_id = ?",
    )
    .bind(galleryId, projectId)
    .run();
}

export async function nextPositionInGallery(
  db: D1Database,
  galleryId: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM gallery_projects WHERE gallery_id = ?",
    )
    .bind(galleryId)
    .first<{ next: number }>();
  return row?.next ?? 0;
}
