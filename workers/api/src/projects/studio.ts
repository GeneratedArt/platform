import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { getProjectById } from "../db/projects";
import { getRepoFile, putRepoFile, GitHubError } from "../lib/github";
import { checkRateLimit } from "../lib/rateLimit";

const SKETCH_PATH = "sketch.js";
// Keep paths inside the repo and reject anything trying to escape.
const PATH_RE = /^[a-zA-Z0-9._/-]+$/;
const MAX_FILE_BYTES = 256 * 1024; // 256 KB — generous for a single sketch
const MAX_PNG_BYTES = 5 * 1024 * 1024; // 5 MB capture cap

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

function validatePath(path: string): string | null {
  if (!path) return SKETCH_PATH;
  if (path.length > 200) return null;
  if (!PATH_RE.test(path)) return null;
  if (path.includes("..")) return null;
  if (path.startsWith("/")) return null;
  return path;
}

/**
 * GET /v1/projects/:id/file?path=sketch.js
 *
 * AUTH + OWNERSHIP required. Project creation accepts `private: true`,
 * which would generate a private GitHub repo — making this endpoint
 * public would let any caller read those private files through the
 * server's central PAT (privilege escalation). Until we add a per-row
 * `visibility` column we fail closed: only the owner can read.
 */
export async function getProjectFileHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `studio:get-file:${session.uid}`,
    limit: 120,
    windowSeconds: 60,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.owner_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!project.repo_full) return c.json({ error: "no_repo" }, 409);

  const rawPath = c.req.query("path") || SKETCH_PATH;
  const path = validatePath(rawPath);
  if (!path) return badRequest(c, "invalid_path");

  try {
    const file = await getRepoFile(c.env, project.repo_full, path);
    return c.json({
      file: {
        path: file.path,
        content: file.content,
        sha: file.sha,
      },
      project: {
        id: project.id,
        slug: project.slug,
        title: project.title,
        engine: project.engine,
        repo_full: project.repo_full,
        repo_url: project.repo_url,
      },
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, detail: err.detail }, err.status as 502);
    }
    throw err;
  }
}

interface CommitBody {
  path?: unknown;
  content?: unknown;
  sha?: unknown;
  message?: unknown;
}

/**
 * POST /v1/projects/:id/commit
 * Auth + ownership. Proxies to GitHub Contents API with the central
 * PAT. Compare-and-swap via blob SHA so concurrent edits 409 cleanly.
 */
export async function commitProjectFileHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.owner_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (project.status === "archived") {
    return c.json({ error: "project_archived" }, 409);
  }
  if (!project.repo_full) {
    return c.json({ error: "no_repo" }, 409);
  }

  // Per-user commit rate limit. 120/hr is generous (one commit every
  // 30s for an hour) but keeps a runaway autosave loop from torching
  // the org's GitHub quota.
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `studio:commit:${session.uid}`,
    limit: 120,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CommitBody;
  try {
    body = await c.req.json<CommitBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const rawPath = typeof body.path === "string" ? body.path : SKETCH_PATH;
  const path = validatePath(rawPath);
  if (!path) return badRequest(c, "invalid_path");

  if (typeof body.content !== "string") {
    return badRequest(c, "invalid_content");
  }
  if (body.content.length > MAX_FILE_BYTES) {
    return badRequest(c, "content_too_large", {
      max_bytes: MAX_FILE_BYTES,
      actual_bytes: body.content.length,
    });
  }

  const sha = typeof body.sha === "string" && body.sha.length > 0 ? body.sha : undefined;
  const isoNow = new Date().toISOString();
  const message =
    typeof body.message === "string" && body.message.trim().length > 0
      ? body.message.slice(0, 200)
      : `studio: ${isoNow}`;

  try {
    const result = await putRepoFile(c.env, project.repo_full, {
      path,
      content: body.content,
      sha,
      message,
    });
    return c.json({ commit: result });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json(
        { error: err.message, detail: err.detail },
        err.status as 409 | 502,
      );
    }
    throw err;
  }
}

interface CaptureBody {
  data_url?: unknown;
  seed?: unknown;
}

const DATA_URL_PREFIX = "data:image/png;base64,";

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

/**
 * POST /v1/projects/:id/captures
 * Accepts a base64 PNG data URL, stores it in R2 under
 * `captures/{projectId}/{timestamp}-{seed}.png`, returns a public URL
 * the client copies to clipboard.
 */
export async function uploadCaptureHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");

  if (!c.env.CAPTURES) {
    return c.json(
      {
        error: "captures_unconfigured",
        detail:
          "R2 CAPTURES bucket is not bound. Uncomment the env.production R2 binding in wrangler.toml.",
      },
      503,
    );
  }

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.owner_id !== session.uid) {
    return c.json({ error: "forbidden" }, 403);
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `studio:capture:${session.uid}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CaptureBody;
  try {
    body = await c.req.json<CaptureBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  if (typeof body.data_url !== "string") {
    return badRequest(c, "invalid_data_url");
  }
  const bytes = decodeDataUrl(body.data_url);
  if (!bytes) {
    return badRequest(c, "invalid_data_url", "expected data:image/png;base64,…");
  }
  if (bytes.byteLength > MAX_PNG_BYTES) {
    return badRequest(c, "capture_too_large", { max_bytes: MAX_PNG_BYTES });
  }

  const seed =
    typeof body.seed === "string"
      ? body.seed.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "noseed"
      : "noseed";
  const ts = Date.now();
  const key = `captures/${project.id}/${ts}-${seed}.png`;
  await c.env.CAPTURES.put(key, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {
      project_id: String(project.id),
      owner_id: String(project.owner_id),
      seed,
    },
  });

  const base =
    c.env.CAPTURES_PUBLIC_BASE && c.env.CAPTURES_PUBLIC_BASE.length > 0
      ? c.env.CAPTURES_PUBLIC_BASE.replace(/\/$/, "")
      : new URL(c.req.url).origin;
  const publicUrl = `${base}/v1/captures/${key}`;
  return c.json({ capture: { key, url: publicUrl, bytes: bytes.byteLength } }, 201);
}

/**
 * GET /v1/captures/captures/:rest+
 * Public read-through for stored PNGs so the data URL path is uniform
 * across dev (no real CDN) and prod (CDN can cache by URL). Long
 * cache headers — captures are immutable.
 */
export async function getCaptureHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.CAPTURES) {
    return c.json({ error: "captures_unconfigured" }, 503);
  }
  // Hono's wildcard captures the full key (already includes
  // `captures/{projectId}/...` because the upload URL is built as
  // ${base}/v1/captures/${key} where key starts with "captures/").
  // Strictly allowlist the prefix + charset so an attacker can't read
  // arbitrary R2 objects this Worker (or any future binding-mate) may
  // have written.
  const key = c.req.param("rest");
  if (!key) return c.json({ error: "invalid_key" }, 400);
  if (!/^captures\/\d+\/[A-Za-z0-9._-]+\.png$/.test(key)) {
    return c.json({ error: "invalid_key" }, 400);
  }
  const obj = await c.env.CAPTURES.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
