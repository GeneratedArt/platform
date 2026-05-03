import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, UserRow } from "../types";
import { getAuthUser, type AuthVariables } from "../auth/middleware";
import {
  getUserById,
  getUserByHandle,
  updateUserProfile,
  type UserProfilePatch,
} from "../db/users";
import {
  followUser,
  unfollowUser,
  isFollowing,
  getFollowCounts,
  listFollowers,
  listFollowing,
} from "../db/follows";
import { checkRateLimit } from "../lib/rateLimit";
import { commitAuthorProfile, GitHubError } from "../lib/github";
import { SESSION_COOKIE } from "../lib/cookies";
import { verifySession } from "../auth/jwt";

// Handle is the URL slug — keep it conservative so it fits everywhere
// (DNS-y URLs, file names like `_authors/{handle}.md`, GitHub commit
// authors). Lower-case alphanumerics + dash, must start with alnum,
// 2-31 chars. Reserved words are blocked to keep room for future
// platform routes.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED_HANDLES = new Set([
  "admin", "api", "assets", "auth", "blog", "blogs", "captures", "connect",
  "contact", "dashboard", "docs", "feed", "follow", "followers", "following",
  "ga", "gallery", "help", "home", "login", "logout", "me", "new", "p",
  "portfolio", "post", "posts", "privacy", "profile", "projects", "settings",
  "shop", "signin", "signup", "studio", "support", "tag", "tags", "terms",
  "u", "user", "users", "v1", "www",
]);

const DISPLAY_NAME_MAX = 60;
const BIO_MAX = 500;
const URL_MAX = 500;
const SOCIAL_LABEL_MAX = 32;
const MAX_SOCIALS = 8;

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

// HTTPS-only by spec — keeps avatars/socials/cover from mixed-content
// downgrades when the page is served over HTTPS. We allow `http://` in
// the local seed authors' Markdown front-matter (loaded directly by
// Jekyll), but for any field that flows through the API we require TLS.
function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && s.length <= URL_MAX;
  } catch {
    return false;
  }
}

interface PublicUser {
  id: number;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_image: string | null;
  socials: Array<{ label: string; url: string }>;
  created_at: number;
}

function publicUser(u: UserRow): PublicUser {
  let socials: Array<{ label: string; url: string }> = [];
  if (u.socials) {
    try {
      const parsed = JSON.parse(u.socials);
      if (Array.isArray(parsed)) {
        socials = parsed.filter(
          (s) => s && typeof s.label === "string" && typeof s.url === "string",
        );
      }
    } catch {
      // Corrupt JSON — surface an empty list rather than a 500. The
      // editor will overwrite on the next save.
      socials = [];
    }
  }
  return {
    id: u.id,
    handle: u.handle,
    display_name: u.display_name,
    bio: u.bio,
    avatar_url: u.avatar_url,
    cover_image: u.cover_image,
    socials,
    created_at: u.created_at,
  };
}

/**
 * Returns the JWT payload if the request carries a valid session cookie.
 * Unlike `requireAuth`, never short-circuits — used for endpoints that
 * stay public but want to enrich the response with viewer context
 * (e.g. `is_following`).
 */
export async function maybeAuthUser(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifySession(c.env.JWT_SECRET, token);
  if (!payload) return null;
  const revoked = await c.env.SESSIONS.get(`revoked:${payload.jti}`);
  if (revoked) return null;
  return payload;
}

/**
 * GET /v1/users/:handle
 *
 * Public profile with follower/following counts. When the caller is
 * authenticated, the response also carries `is_following` and
 * `is_self` so the profile page can render the right CTA without a
 * second round-trip.
 */
export async function getUserByHandleHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const handle = (c.req.param("handle") || "").toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return badRequest(c, "invalid_handle");
  }
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.json({ error: "not_found" }, 404);

  const counts = await getFollowCounts(c.env.DB, user.id);
  const viewer = await maybeAuthUser(c);

  const body: Record<string, unknown> = {
    user: publicUser(user),
    counts,
  };
  if (viewer) {
    body.is_self = viewer.uid === user.id;
    body.is_following =
      viewer.uid === user.id
        ? false
        : await isFollowing(c.env.DB, viewer.uid, user.id);
    // Viewer-specific (`is_self`, `is_following`) — must NOT land in any
    // shared cache, or a logged-in viewer's follow state will be served
    // to anonymous visitors. `Vary: Cookie` belt-and-braces in case a
    // CDN ignores `private`.
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie");
  } else {
    // Anonymous response is identical for everyone — safe to cache at
    // the edge with SWR. Profile data is read-mostly; the follow
    // button has its own optimistic update path on the client.
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  }
  return c.json(body);
}

/**
 * PATCH /v1/me
 *
 * Auth required. Updates D1 user row and (best-effort) commits a
 * fresh `_authors/{handle}.md` to the site repo so the static
 * `/@{handle}/` page reflects the change after the next Pages build.
 *
 * The GitHub commit is fire-and-forget from the response's POV: we
 * await it for status reporting but do not roll back the D1 update on
 * failure — D1 is the source of truth, the markdown is a render cache.
 */
interface PatchMeBody {
  handle?: unknown;
  display_name?: unknown;
  bio?: unknown;
  avatar_url?: unknown;
  cover_image?: unknown;
  socials?: unknown;
}

export async function patchMeHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `me:patch:${session.uid}`,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: PatchMeBody;
  try {
    body = await c.req.json<PatchMeBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const patch: UserProfilePatch = {};
  let handleChanged = false;
  let oldHandle: string | null = null;

  if (body.handle !== undefined) {
    if (typeof body.handle !== "string") return badRequest(c, "invalid_handle");
    const candidate = body.handle.toLowerCase().trim();
    if (!HANDLE_RE.test(candidate)) return badRequest(c, "invalid_handle");
    if (RESERVED_HANDLES.has(candidate)) return badRequest(c, "reserved_handle");
    const current = await getUserById(c.env.DB, session.uid);
    if (!current) return c.json({ error: "user_not_found" }, 404);
    if (candidate !== current.handle) {
      const taken = await getUserByHandle(c.env.DB, candidate);
      if (taken) return c.json({ error: "handle_taken" }, 409);
      patch.handle = candidate;
      handleChanged = true;
      oldHandle = current.handle;
    }
  }
  if (body.display_name !== undefined) {
    if (body.display_name === null) {
      patch.display_name = null;
    } else if (typeof body.display_name !== "string") {
      return badRequest(c, "invalid_display_name");
    } else {
      const trimmed = body.display_name.trim().slice(0, DISPLAY_NAME_MAX);
      patch.display_name = trimmed.length === 0 ? null : trimmed;
    }
  }
  if (body.bio !== undefined) {
    if (body.bio === null) {
      patch.bio = null;
    } else if (typeof body.bio !== "string") {
      return badRequest(c, "invalid_bio");
    } else {
      const trimmed = body.bio.trim().slice(0, BIO_MAX);
      patch.bio = trimmed.length === 0 ? null : trimmed;
    }
  }
  if (body.avatar_url !== undefined) {
    if (body.avatar_url === null) {
      patch.avatar_url = null;
    } else if (typeof body.avatar_url !== "string" || !isHttpsUrl(body.avatar_url)) {
      return badRequest(c, "invalid_avatar_url");
    } else {
      patch.avatar_url = body.avatar_url;
    }
  }
  if (body.cover_image !== undefined) {
    if (body.cover_image === null) {
      patch.cover_image = null;
    } else if (typeof body.cover_image !== "string" || !isHttpsUrl(body.cover_image)) {
      return badRequest(c, "invalid_cover_image");
    } else {
      patch.cover_image = body.cover_image;
    }
  }
  if (body.socials !== undefined) {
    if (body.socials === null) {
      patch.socials = null;
    } else if (!Array.isArray(body.socials)) {
      return badRequest(c, "invalid_socials");
    } else if (body.socials.length > MAX_SOCIALS) {
      return badRequest(c, "too_many_socials", { max: MAX_SOCIALS });
    } else {
      const cleaned: Array<{ label: string; url: string }> = [];
      for (const raw of body.socials) {
        if (
          !raw ||
          typeof raw !== "object" ||
          typeof (raw as { label?: unknown }).label !== "string" ||
          typeof (raw as { url?: unknown }).url !== "string"
        ) {
          return badRequest(c, "invalid_social_entry");
        }
        const label = (raw as { label: string }).label.trim().slice(0, SOCIAL_LABEL_MAX);
        const url = (raw as { url: string }).url.trim();
        if (!label) return badRequest(c, "invalid_social_label");
        if (!isHttpsUrl(url)) return badRequest(c, "invalid_social_url");
        cleaned.push({ label, url });
      }
      patch.socials = cleaned;
    }
  }

  let updated: UserRow | null;
  try {
    updated = await updateUserProfile(c.env.DB, session.uid, patch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      // Handle race where someone grabbed the handle between our
      // pre-check and the UPDATE. Surface the same 409 the client
      // already handles.
      return c.json({ error: "handle_taken" }, 409);
    }
    throw err;
  }
  if (!updated) return c.json({ error: "user_not_found" }, 404);

  // Best-effort commit the rendered profile MD. We surface the result
  // (or skip reason) to the client so the editor can show "live in ~1
  // min" vs "static page won't update — D1 is current though".
  let github_status: { committed: boolean; reason?: string; commit_sha?: string; html_url?: string | null } = {
    committed: false,
    reason: "not_attempted",
  };
  try {
    const result = await commitAuthorProfile(c.env, {
      handle: updated.handle,
      display_name: updated.display_name,
      bio: updated.bio,
      avatar_url: updated.avatar_url,
      cover_image: updated.cover_image,
      socials: publicUser(updated).socials,
      address: updated.address,
      // If the handle changed, ask the helper to delete the old MD so
      // the old `/@old/` route 404s on the next build instead of
      // serving stale data.
      previousHandle: handleChanged ? oldHandle : null,
    });
    github_status = result;
  } catch (err) {
    if (err instanceof GitHubError) {
      console.error("profile_commit_failed", err.status, err.detail);
      github_status = {
        committed: false,
        reason: `github_error_${err.status}`,
      };
    } else {
      console.error("profile_commit_unexpected", err);
      github_status = { committed: false, reason: "unexpected_error" };
    }
  }

  return c.json({ user: publicUser(updated), github_status });
}

/**
 * POST /v1/users/:handle/follow  (auth)
 * Idempotent — re-following is a no-op that still returns the fresh count.
 */
export async function followHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const handle = (c.req.param("handle") || "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return badRequest(c, "invalid_handle");

  const target = await getUserByHandle(c.env.DB, handle);
  if (!target) return c.json({ error: "not_found" }, 404);
  if (target.id === session.uid) {
    return c.json({ error: "self_follow_forbidden" }, 400);
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `follow:${session.uid}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  await followUser(c.env.DB, session.uid, target.id);
  const counts = await getFollowCounts(c.env.DB, target.id);
  return c.json({ is_following: true, counts });
}

/**
 * DELETE /v1/users/:handle/follow  (auth)
 * Idempotent — un-following someone you don't follow returns 200.
 */
export async function unfollowHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const handle = (c.req.param("handle") || "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return badRequest(c, "invalid_handle");

  const target = await getUserByHandle(c.env.DB, handle);
  if (!target) return c.json({ error: "not_found" }, 404);
  if (target.id === session.uid) {
    return c.json({ error: "self_follow_forbidden" }, 400);
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `follow:${session.uid}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  await unfollowUser(c.env.DB, session.uid, target.id);
  const counts = await getFollowCounts(c.env.DB, target.id);
  return c.json({ is_following: false, counts });
}

export async function listFollowersHandler(c: Context<{ Bindings: Env }>) {
  const handle = (c.req.param("handle") || "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return badRequest(c, "invalid_handle");
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.json({ error: "not_found" }, 404);
  const followers = await listFollowers(c.env.DB, user.id, 100);
  return c.json({ followers });
}

export async function listFollowingHandler(c: Context<{ Bindings: Env }>) {
  const handle = (c.req.param("handle") || "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return badRequest(c, "invalid_handle");
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.json({ error: "not_found" }, 404);
  const following = await listFollowing(c.env.DB, user.id, 100);
  return c.json({ following });
}
