/**
 * Artist applications (§8.1). Flow:
 *
 *   POST /applications          — authenticated user submits an application,
 *                                 we create a GitHub Issue in the org's
 *                                 `applications` repo and store a mirror row.
 *   GET  /applications/me       — caller's most recent application.
 *   GET  /applications          — curator-only list of pending applications.
 *   POST /applications/:id/withdraw — applicant cancels their pending request.
 *
 * Approval is event-driven: when a curator labels the GitHub issue
 * `approved`, GitHub posts a webhook to /webhooks/github which flips the
 * mirror row and upgrades the user's role to `artist`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { Env, Variables } from "../lib/env";
import { requireAuth, requireRole } from "../lib/middleware";
import { audit } from "../lib/audit";
import { createApplicationIssue } from "../lib/github-app";

export const applicationRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

const SubmitInput = z.object({
  artist_slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  bio: z.string().min(40).max(2000),
  portfolio_links: z.array(z.string().url()).min(1).max(8),
  wallet_address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

applicationRoutes.post("/", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  let parsed;
  try {
    parsed = SubmitInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }

  // Block duplicate pending applications (covered by UNIQUE index but we want
  // a friendlier error than a constraint violation).
  const existing = await c.env.DB.prepare(
    `SELECT id, status, github_url FROM applications
     WHERE user_id = ? AND status = 'pending'`
  )
    .bind(userId)
    .first<{ id: string; status: string; github_url: string | null }>();
  if (existing) {
    return c.json(
      { error: "already_pending", application_id: existing.id, github_url: existing.github_url },
      409
    );
  }

  // Caller must have signed in with GitHub so the issue carries a real handle.
  const user = await c.env.DB.prepare(
    `SELECT github_login, role FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ github_login: string | null; role: string }>();
  if (!user?.github_login) {
    return c.json({ error: "github_login_required" }, 400);
  }
  if (user.role === "artist" || user.role === "curator" || user.role === "steward") {
    return c.json({ error: "already_artist" }, 409);
  }

  let issue: { number: number; html_url: string };
  try {
    issue = await createApplicationIssue(c.env, {
      artistSlug: parsed.artist_slug,
      githubLogin: user.github_login,
      bio: parsed.bio,
      portfolioLinks: parsed.portfolio_links,
      walletAddress: parsed.wallet_address ?? null,
    });
  } catch (err) {
    return c.json(
      { error: "github_issue_failed", detail: (err as Error).message },
      503
    );
  }

  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO applications
       (id, user_id, artist_slug, bio, portfolio_links, wallet_address,
        github_issue, github_url, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      userId,
      parsed.artist_slug,
      parsed.bio,
      JSON.stringify(parsed.portfolio_links),
      parsed.wallet_address ?? null,
      issue.number,
      issue.html_url,
      Date.now()
    )
    .run();

  await audit(c.env, userId, "application.submit", id, {
    artist_slug: parsed.artist_slug,
    issue: issue.number,
  });

  return c.json({
    id,
    status: "pending",
    artist_slug: parsed.artist_slug,
    github_issue: issue.number,
    github_url: issue.html_url,
  });
});

applicationRoutes.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const row = await c.env.DB.prepare(
    `SELECT id, artist_slug, status, github_issue, github_url, created_at, reviewed_at
     FROM applications WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId)
    .first();
  return c.json({ application: row ?? null });
});

applicationRoutes.get("/", requireRole("curator"), async (c) => {
  const allowed = new Set(["pending", "approved", "rejected", "withdrawn"]);
  const raw = c.req.query("status") ?? "pending";
  const status = allowed.has(raw) ? raw : "pending";
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.artist_slug, a.status, a.github_issue, a.github_url,
            a.created_at, u.github_login, u.display_name
     FROM applications a JOIN users u ON u.id = a.user_id
     WHERE a.status = ?
     ORDER BY a.created_at DESC LIMIT 200`
  )
    .bind(status)
    .all();
  return c.json({ applications: rows.results ?? [] });
});

applicationRoutes.post("/:id/withdraw", requireAuth, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId")!;
  const row = await c.env.DB.prepare(
    `SELECT user_id, status FROM applications WHERE id = ?`
  )
    .bind(id)
    .first<{ user_id: string; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.user_id !== userId) return c.json({ error: "forbidden" }, 403);
  if (row.status !== "pending") {
    return c.json({ error: "invalid_status", current: row.status }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE applications SET status = 'withdrawn', reviewed_at = ? WHERE id = ?`
  )
    .bind(Date.now(), id)
    .run();
  await audit(c.env, userId, "application.withdraw", id, {});
  return c.json({ ok: true, status: "withdrawn" });
});
