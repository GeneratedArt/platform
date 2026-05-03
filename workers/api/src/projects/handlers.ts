import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { uniqueProjectSlug } from "../lib/slug";
import {
  archiveRepo,
  generateRepoFromTemplate,
  GitHubError,
} from "../lib/github";
// archiveRepo is also used as the orphan-repo compensation when the D1
// insert fails after a successful GitHub create.
import {
  ENGINES,
  STATUSES,
  type ProjectEngine,
  type ProjectStatus,
  insertProject,
  getProjectById,
  getProjectOwner,
  listProjectsByHandle,
  listProjectsByOwner,
  updateProject,
  publicProject,
  PUBLIC_STATUSES,
} from "../db/projects";
import { getUserById } from "../db/users";
import { maybeAuthUser } from "../users/handlers";
import { checkRateLimit } from "../lib/rateLimit";
import { recordProjectView } from "../db/events";

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 500;

interface CreateBody {
  title?: unknown;
  description?: unknown;
  engine?: unknown;
  license?: unknown;
  private?: unknown;
}

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

export async function createProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `projects:create:${session.uid}`,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) {
    return badRequest(c, "invalid_title");
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, DESCRIPTION_MAX)
      : null;
  const engine = typeof body.engine === "string" ? body.engine : "p5";
  if (!ENGINES.includes(engine as ProjectEngine)) {
    return badRequest(c, "invalid_engine", { allowed: ENGINES });
  }
  const license =
    typeof body.license === "string" ? body.license : "CC-BY-NC-4.0";
  const isPrivate = body.private === true;

  const user = await getUserById(c.env.DB, session.uid);
  if (!user) return c.json({ error: "user_not_found" }, 404);

  const baseSlug = `${user.handle}-${title}`;
  const slug = await uniqueProjectSlug(c.env.DB, user.id, baseSlug);
  const repoName = slug;

  let repo;
  try {
    repo = await generateRepoFromTemplate(c.env, {
      repoName,
      description: description || `${title} — generative art on GeneratedArt`,
      private: isPrivate,
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      console.error("github_generate_failed", err.status, err.detail);
      return c.json(
        { error: err.message, detail: err.detail },
        err.status >= 400 && err.status < 600 ? (err.status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503) : 502,
      );
    }
    throw err;
  }

  let project;
  try {
    project = await insertProject(c.env.DB, {
      ownerId: user.id,
      slug,
      title,
      description,
      engine: engine as ProjectEngine,
      license,
      repoUrl: repo.html_url,
      repoFull: repo.full_name,
    });
  } catch (dbErr) {
    // The GitHub repo was created but the D1 insert failed. Compensate
    // by archiving the orphan repo so we don't leave the org cluttered
    // with unreferenced projects. Best-effort: log + swallow archive
    // errors so the user still sees the original DB failure.
    console.error("project_insert_failed_after_repo_create", dbErr);
    try {
      await archiveRepo(c.env, repo.full_name);
    } catch (archiveErr) {
      console.error("orphan_repo_compensation_failed", repo.full_name, archiveErr);
    }
    throw dbErr;
  }

  return c.json({ project: publicProject(project) }, 201);
}

export async function getProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const row = await getProjectById(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  // `draft` and `archived` projects are owner-private. Anyone else
  // (anonymous or a different signed-in user) gets a 404 — same shape
  // as if the project never existed, to avoid leaking ownership info.
  const viewer = await maybeAuthUser(c);
  const isOwner = viewer?.uid === row.owner_id;
  if (!isOwner && !PUBLIC_STATUSES.includes(row.status as ProjectStatus)) {
    return c.json({ error: "not_found" }, 404);
  }

  const owner = await getProjectOwner(c.env.DB, row.owner_id);

  // Record a view event for the trending score on /explore.
  // Public-status projects only; owners viewing their own work shouldn't
  // boost trending. Best-effort: a failure here mustn't break the read,
  // and the IP-hash dedupe in recordProjectView keeps the increment
  // honest even under refresh-spam.
  if (!isOwner && PUBLIC_STATUSES.includes(row.status as ProjectStatus)) {
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown";
    try {
      await recordProjectView(c.env.DB, row.id, ip);
    } catch (e) {
      console.error("record_project_view_failed", row.id, e);
    }
  }

  return c.json({ project: publicProject(row), owner });
}

interface PatchBody {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  cover_url?: unknown;
  frozen_cid?: unknown;
}

// CIDv1 base32: starts with 'b', then 1-2 multibase-encoded chars,
// then a-z2-7 base32 payload. We only accept CIDv1 to keep storage
// uniform; CIDv0 (Qm…) is allowed too because some pinning services
// still emit it.
function isValidCid(s: string): boolean {
  if (s.length < 46 || s.length > 100) return false;
  if (s.startsWith("Qm") && /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) return true;
  return /^b[a-z2-7]{45,99}$/.test(s);
}

export async function patchProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const existing = await getProjectById(c.env.DB, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.owner_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: PatchBody;
  try {
    body = await c.req.json<PatchBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const patch: Parameters<typeof updateProject>[2] = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > TITLE_MAX) {
      return badRequest(c, "invalid_title");
    }
    patch.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return badRequest(c, "invalid_description");
    }
    patch.description = body.description == null ? null : String(body.description).slice(0, DESCRIPTION_MAX);
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status as ProjectStatus)) {
      return badRequest(c, "invalid_status", { allowed: STATUSES });
    }
    // Archival has GitHub side effects (the repo must be archived too)
    // and is only safe through POST /v1/projects/:id/archive. Allowing
    // PATCH status='archived' would let an external client put the row
    // into archived state without touching GitHub, leaving state drift.
    if (body.status === "archived") {
      return badRequest(c, "use_archive_endpoint", {
        endpoint: `/v1/projects/${id}/archive`,
      });
    }
    patch.status = body.status as ProjectStatus;
  }
  if (body.cover_url !== undefined) {
    if (body.cover_url !== null && typeof body.cover_url !== "string") {
      return badRequest(c, "invalid_cover_url");
    }
    patch.cover_url = body.cover_url == null ? null : String(body.cover_url);
  }
  if (body.frozen_cid !== undefined) {
    // Once a project is deployed AND its CID is locked on-chain, the
    // D1 row is read-only for this column — the contract is the source
    // of truth and the artist can't rotate it. Before deploy/lock the
    // artist can freely re-pin and overwrite the CID.
    if (body.frozen_cid !== null && typeof body.frozen_cid !== "string") {
      return badRequest(c, "invalid_frozen_cid");
    }
    if (typeof body.frozen_cid === "string" && !isValidCid(body.frozen_cid)) {
      return badRequest(c, "invalid_frozen_cid");
    }
    if (existing.contract_address && existing.frozen_cid) {
      return c.json({ error: "frozen_cid_locked" }, 409);
    }
    patch.frozen_cid = body.frozen_cid == null ? null : body.frozen_cid;
  }

  const updated = await updateProject(c.env.DB, id, patch);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ project: publicProject(updated) });
}

export async function archiveProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const existing = await getProjectById(c.env.DB, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.owner_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (existing.status === "archived") {
    return c.json({ project: publicProject(existing) });
  }

  if (existing.repo_full) {
    try {
      await archiveRepo(c.env, existing.repo_full);
    } catch (err) {
      if (err instanceof GitHubError) {
        console.error("github_archive_failed", err.status, err.detail);
        return c.json({ error: err.message, detail: err.detail }, 502);
      }
      throw err;
    }
  }

  const updated = await updateProject(c.env.DB, id, { status: "archived" });
  return c.json({ project: publicProject(updated!) });
}

export async function listMyProjects(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const rows = await listProjectsByOwner(c.env.DB, session.uid);
  return c.json({ projects: rows.map(publicProject) });
}

export async function listProjectsForHandle(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const handle = c.req.param("handle");
  if (!handle) return badRequest(c, "invalid_handle");
  // Owner sees drafts + archived; everyone else only sees public
  // statuses (published/minted). Filtering happens in SQL so a
  // misbehaving client cannot bypass it.
  const viewer = await maybeAuthUser(c);
  const rows = await listProjectsByHandle(c.env.DB, handle, {
    viewerUid: viewer?.uid,
  });
  return c.json({ projects: rows.map(publicProject) });
}
