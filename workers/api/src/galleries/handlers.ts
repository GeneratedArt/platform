import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { checkRateLimit } from "../lib/rateLimit";
import { uniqueGallerySlug } from "../lib/slug";
import {
  insertGallery,
  getGalleryBySlug,
  getGalleryCurator,
  listGalleries,
  listProjectsInGallery,
  listGalleriesForProject,
  updateGallery,
  addProjectToGallery,
  removeProjectFromGallery,
  nextPositionInGallery,
  type GalleryRow,
  type GalleryListItem,
  type GalleryProject,
} from "../db/galleries";
import { getProjectById } from "../db/projects";
import { getUserById } from "../db/users";
import { recordGalleryAddedEvent } from "../db/events";

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 280;
const BODY_MAX = 10_000;
const LOCATION_MAX = 120;
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const ABS_FAR_FUTURE = Math.floor(Date.now() / 1000) + 100 * 365 * 86400;

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

// `null` means "no value" (absent, empty, or wrong type). Over-length is
// a distinct outcome — see `checkedStr` — because collapsing the two made
// a 300-character description on a 280-character field save as NULL
// instead of returning 400, silently destroying what the curator typed.
function clampStr(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) return null;
  return t;
}

const TOO_LONG = Symbol("too_long");

/// Like clampStr, but distinguishes "too long" from "absent" so the
/// caller can 400 instead of writing NULL over the user's input.
function checkedStr(v: unknown, max: number): string | null | typeof TOO_LONG {
  if (typeof v === "string" && v.trim().length > max) return TOO_LONG;
  return clampStr(v, max);
}

function clampLatLon(
  v: unknown,
  range: number,
): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > range) return { ok: false };
  return { ok: true, value: n };
}

function clampUnix(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > ABS_FAR_FUTURE) return { ok: false };
  return { ok: true, value: n };
}

function publicGallery(
  g: GalleryRow,
  curator:
    | { id: number; handle: string; display_name: string | null; avatar_url: string | null }
    | null,
  projects?: GalleryProject[],
) {
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    body_md: g.body_md,
    cover_url: g.cover_url,
    location: g.location,
    lat: g.lat,
    lon: g.lon,
    starts_at: g.starts_at,
    ends_at: g.ends_at,
    created_at: g.created_at,
    updated_at: g.updated_at,
    curator: curator
      ? {
          id: curator.id,
          handle: curator.handle,
          display_name: curator.display_name,
          avatar_url: curator.avatar_url,
        }
      : null,
    projects: projects ?? undefined,
  };
}

function publicListItem(g: GalleryListItem) {
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    cover_url: g.cover_url,
    location: g.location,
    starts_at: g.starts_at,
    ends_at: g.ends_at,
    created_at: g.created_at,
    project_count: g.project_count,
    curator: g.curator_id
      ? {
          id: g.curator_id,
          handle: g.curator_handle,
          display_name: g.curator_display_name,
          avatar_url: g.curator_avatar_url,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/galleries
// Public listing. Optional `?curator=handle` and pagination by
// `?before=<unix-seconds>`.
// ---------------------------------------------------------------------------
export async function listGalleriesHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const limitRaw = c.req.query("limit");
  let limit = LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: LIST_MAX });
    }
    limit = n;
  }
  const beforeRaw = c.req.query("before");
  let before: number | undefined;
  if (beforeRaw) {
    const n = parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) return badRequest(c, "invalid_before");
    before = n;
  }
  let curatorId: number | undefined;
  const curatorHandle = c.req.query("curator");
  if (curatorHandle) {
    const u = await c.env.DB.prepare(
      "SELECT id FROM users WHERE handle = ?",
    )
      .bind(curatorHandle.toLowerCase())
      .first<{ id: number }>();
    if (!u) {
      // Empty list rather than 404 — same shape as filtering on a
      // tag that nobody has used yet.
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return c.json({ galleries: [], next_before: null });
    }
    curatorId = u.id;
  }

  const rows = await listGalleries(c.env.DB, { limit, before, curatorId });
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({
    galleries: rows.map(publicListItem),
    next_before:
      rows.length === limit ? rows[rows.length - 1].created_at : null,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/galleries/:slug
// ---------------------------------------------------------------------------
export async function getGalleryHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return badRequest(c, "invalid_slug");
  const gallery = await getGalleryBySlug(c.env.DB, slug);
  if (!gallery) return c.json({ error: "not_found" }, 404);
  const curator = gallery.curator_id
    ? await getGalleryCurator(c.env.DB, gallery.curator_id)
    : null;
  const projects = await listProjectsInGallery(c.env.DB, gallery.id);
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({ gallery: publicGallery(gallery, curator, projects) });
}

// ---------------------------------------------------------------------------
// POST /v1/galleries
// ---------------------------------------------------------------------------
interface CreateBody {
  title?: unknown;
  description?: unknown;
  body_md?: unknown;
  cover_url?: unknown;
  location?: unknown;
  lat?: unknown;
  lon?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
}

export async function createGalleryHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const user = await getUserById(c.env.DB, session.uid);
  if (!user) return c.json({ error: "user_not_found" }, 404);
  if (!user.is_curator) {
    return c.json(
      {
        error: "not_a_curator",
        detail:
          "Only verified curators can create galleries. Open a brief in the `gallery` industry to request access.",
      },
      403,
    );
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `galleries:create:${session.uid}`,
    limit: 10,
    windowSeconds: 86400,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const title = clampStr(body.title, TITLE_MAX);
  if (!title) return badRequest(c, "invalid_title", { max: TITLE_MAX });
  const description = checkedStr(body.description, DESCRIPTION_MAX);
  if (description === TOO_LONG) {
    return badRequest(c, "description_too_long", { max: DESCRIPTION_MAX });
  }
  const bodyMd = checkedStr(body.body_md, BODY_MAX);
  if (bodyMd === TOO_LONG) {
    return badRequest(c, "body_md_too_long", { max: BODY_MAX });
  }
  const coverUrl = body.cover_url === null ? null : checkedStr(body.cover_url, 500);
  if (coverUrl === TOO_LONG) {
    return badRequest(c, "cover_url_too_long", { max: 500 });
  }
  const location = checkedStr(body.location, LOCATION_MAX);
  if (location === TOO_LONG) {
    return badRequest(c, "location_too_long", { max: LOCATION_MAX });
  }

  const lat = clampLatLon(body.lat, 90);
  if (!lat.ok) return badRequest(c, "invalid_lat");
  const lon = clampLatLon(body.lon, 180);
  if (!lon.ok) return badRequest(c, "invalid_lon");
  const startsAt = clampUnix(body.starts_at);
  if (!startsAt.ok) return badRequest(c, "invalid_starts_at");
  const endsAt = clampUnix(body.ends_at);
  if (!endsAt.ok) return badRequest(c, "invalid_ends_at");
  if (
    startsAt.value !== null &&
    endsAt.value !== null &&
    endsAt.value < startsAt.value
  ) {
    return badRequest(c, "ends_before_starts");
  }
  // lat without lon (or vice versa) won't render a tile; require both
  // or neither so the public page doesn't display half-data.
  if ((lat.value === null) !== (lon.value === null)) {
    return badRequest(c, "lat_lon_must_pair");
  }

  const slug = await uniqueGallerySlug(c.env.DB, title);
  const gallery = await insertGallery(c.env.DB, {
    curatorId: session.uid,
    slug,
    title,
    description,
    bodyMd,
    coverUrl: coverUrl ?? null,
    location,
    lat: lat.value,
    lon: lon.value,
    startsAt: startsAt.value,
    endsAt: endsAt.value,
  });

  const curator = await getGalleryCurator(c.env.DB, session.uid);
  return c.json({ gallery: publicGallery(gallery, curator) }, 201);
}

// ---------------------------------------------------------------------------
// PATCH /v1/galleries/:slug
// ---------------------------------------------------------------------------
type PatchBody = CreateBody;

export async function patchGalleryHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return badRequest(c, "invalid_slug");
  const existing = await getGalleryBySlug(c.env.DB, slug);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.curator_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: PatchBody;
  try {
    body = await c.req.json<PatchBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const patch: Parameters<typeof updateGallery>[2] = {};
  if (body.title !== undefined) {
    const t = clampStr(body.title, TITLE_MAX);
    if (!t) return badRequest(c, "invalid_title", { max: TITLE_MAX });
    patch.title = t;
  }
  if (body.description !== undefined) {
    const v = body.description === null ? null : checkedStr(body.description, DESCRIPTION_MAX);
    if (v === TOO_LONG) {
      return badRequest(c, "description_too_long", { max: DESCRIPTION_MAX });
    }
    patch.description = v;
  }
  if (body.body_md !== undefined) {
    const v = body.body_md === null ? null : checkedStr(body.body_md, BODY_MAX);
    if (v === TOO_LONG) return badRequest(c, "body_md_too_long", { max: BODY_MAX });
    patch.bodyMd = v;
  }
  if (body.cover_url !== undefined) {
    const v = body.cover_url === null ? null : checkedStr(body.cover_url, 500);
    if (v === TOO_LONG) return badRequest(c, "cover_url_too_long", { max: 500 });
    patch.coverUrl = v;
  }
  if (body.location !== undefined) {
    const v = body.location === null ? null : checkedStr(body.location, LOCATION_MAX);
    if (v === TOO_LONG) {
      return badRequest(c, "location_too_long", { max: LOCATION_MAX });
    }
    patch.location = v;
  }
  if (body.lat !== undefined) {
    const r = clampLatLon(body.lat, 90);
    if (!r.ok) return badRequest(c, "invalid_lat");
    patch.lat = r.value;
  }
  if (body.lon !== undefined) {
    const r = clampLatLon(body.lon, 180);
    if (!r.ok) return badRequest(c, "invalid_lon");
    patch.lon = r.value;
  }
  if (body.starts_at !== undefined) {
    const r = clampUnix(body.starts_at);
    if (!r.ok) return badRequest(c, "invalid_starts_at");
    patch.startsAt = r.value;
  }
  if (body.ends_at !== undefined) {
    const r = clampUnix(body.ends_at);
    if (!r.ok) return badRequest(c, "invalid_ends_at");
    patch.endsAt = r.value;
  }

  // Revalidate range/pair invariants against the *post-patch* values
  // so a PATCH that updates only one of {starts_at, ends_at} still
  // catches a flipped range.
  const finalStarts = patch.startsAt !== undefined ? patch.startsAt : existing.starts_at;
  const finalEnds   = patch.endsAt   !== undefined ? patch.endsAt   : existing.ends_at;
  if (finalStarts !== null && finalEnds !== null && finalEnds < finalStarts) {
    return badRequest(c, "ends_before_starts");
  }
  const finalLat = patch.lat !== undefined ? patch.lat : existing.lat;
  const finalLon = patch.lon !== undefined ? patch.lon : existing.lon;
  if ((finalLat === null) !== (finalLon === null)) {
    return badRequest(c, "lat_lon_must_pair");
  }

  const updated = await updateGallery(c.env.DB, existing.id, patch);
  if (!updated) return c.json({ error: "not_found" }, 404);
  const curator = await getGalleryCurator(c.env.DB, session.uid);
  return c.json({ gallery: publicGallery(updated, curator) });
}

// ---------------------------------------------------------------------------
// POST /v1/galleries/:slug/projects   { project_id, action: "add"|"remove" }
// ---------------------------------------------------------------------------
interface ProjectsBody {
  project_id?: unknown;
  action?: unknown;
}

export async function galleryProjectsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return badRequest(c, "invalid_slug");
  const gallery = await getGalleryBySlug(c.env.DB, slug);
  if (!gallery) return c.json({ error: "not_found" }, 404);
  if (gallery.curator_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: ProjectsBody;
  try {
    body = await c.req.json<ProjectsBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const projectId =
    typeof body.project_id === "number"
      ? body.project_id
      : typeof body.project_id === "string"
        ? parseInt(body.project_id, 10)
        : NaN;
  if (!Number.isFinite(projectId) || projectId < 1) {
    return badRequest(c, "invalid_project_id");
  }
  const action = body.action;
  if (action !== "add" && action !== "remove") {
    return badRequest(c, "invalid_action", { allowed: ["add", "remove"] });
  }

  const project = await getProjectById(c.env.DB, projectId);
  if (!project) return c.json({ error: "project_not_found" }, 404);
  // Only public projects can be curated. Drafts and archived are
  // owner-private — surfacing them via a gallery would leak unfinished
  // work.
  if (action === "add" && !["published", "minted"].includes(project.status)) {
    return c.json({ error: "project_not_public" }, 409);
  }

  if (action === "remove") {
    await removeProjectFromGallery(c.env.DB, gallery.id, projectId);
    return c.json({ ok: true, action });
  }

  const position = await nextPositionInGallery(c.env.DB, gallery.id);
  const { inserted } = await addProjectToGallery(
    c.env.DB,
    gallery.id,
    projectId,
    position,
  );

  // Emit notification only on first insert — re-adding an already-
  // present project must not double-notify the artist.
  if (inserted && project.owner_id !== session.uid) {
    try {
      await recordGalleryAddedEvent(c.env.DB, {
        curatorId: session.uid,
        artistId: project.owner_id,
        projectId: project.id,
        galleryId: gallery.id,
        gallerySlug: gallery.slug,
        galleryTitle: gallery.title,
        projectTitle: project.title,
      });
    } catch (e) {
      console.error("event_gallery_added_failed", e);
    }
  }
  return c.json({ ok: true, action, inserted });
}

// ---------------------------------------------------------------------------
// POST /v1/galleries/cover  — auth + is_curator. Uploads a base64 PNG
// to R2 under `gallery-covers/{userId}/{ts}-{n}.png` and returns a
// public URL the client patches into the gallery row.
// ---------------------------------------------------------------------------
const DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_PNG_BYTES = 5 * 1024 * 1024;

function decodeDataUrl(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) return null;
  const b64 = dataUrl.slice(DATA_URL_PREFIX.length);
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

interface CoverBody {
  data_url?: unknown;
}

export async function uploadGalleryCoverHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const user = await getUserById(c.env.DB, session.uid);
  if (!user) return c.json({ error: "user_not_found" }, 404);
  if (!user.is_curator) {
    return c.json({ error: "not_a_curator" }, 403);
  }

  if (!c.env.CAPTURES) {
    return c.json(
      {
        error: "captures_unconfigured",
        detail: "R2 CAPTURES bucket is not bound.",
      },
      503,
    );
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `galleries:cover:${session.uid}`,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CoverBody;
  try {
    body = await c.req.json<CoverBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  if (typeof body.data_url !== "string") {
    return badRequest(c, "invalid_data_url");
  }
  const bytes = decodeDataUrl(body.data_url);
  if (!bytes) return badRequest(c, "invalid_data_url", "expected data:image/png;base64,…");
  if (bytes.byteLength > MAX_PNG_BYTES) {
    return badRequest(c, "cover_too_large", { max_bytes: MAX_PNG_BYTES });
  }

  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1e6);
  const key = `gallery-covers/${session.uid}/${ts}-${rand}.png`;
  await c.env.CAPTURES.put(key, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {
      curator_id: String(session.uid),
      kind: "gallery-cover",
    },
  });

  const base =
    c.env.CAPTURES_PUBLIC_BASE && c.env.CAPTURES_PUBLIC_BASE.length > 0
      ? c.env.CAPTURES_PUBLIC_BASE.replace(/\/$/, "")
      : new URL(c.req.url).origin;
  const publicUrl = `${base}/v1/captures/${key}`;
  return c.json({ cover: { key, url: publicUrl, bytes: bytes.byteLength } }, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/projects/:id/galleries — "Curated by" reverse lookup.
// ---------------------------------------------------------------------------
export async function projectGalleriesHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (!Number.isFinite(id) || id < 1) return badRequest(c, "invalid_id");
  const rows = await listGalleriesForProject(c.env.DB, id, 10);
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json({ project_id: id, galleries: rows });
}

