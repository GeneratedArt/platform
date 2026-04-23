/**
 * GitHub App webhook receiver. Verifies the HMAC signature and dispatches:
 *
 *   issues.labeled  in `applications` repo, label `approved`
 *     → mark application approved, upgrade user.role to `artist`.
 *   issues.labeled  in `applications` repo, label `rejected`
 *     → mark application rejected.
 *
 * The webhook secret lives in env.GITHUB_WEBHOOK_SECRET. Configure it on the
 * GitHub App's webhook page; we'll only respond 2xx if the signature matches.
 */
import { Hono } from "hono";
import type { Env, Variables } from "../lib/env";
import { audit } from "../lib/audit";

export const webhookRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const enc = new TextEncoder();

async function verifySignature(secret: string, body: string, sigHeader: string | null) {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const provided = sigHeader.slice(7);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time compare.
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

interface IssueEvent {
  action: string;
  issue: { number: number; html_url: string; state: string };
  label?: { name: string };
  repository: { name: string; full_name: string };
  sender: { login: string };
}

webhookRoutes.post("/github", async (c) => {
  if (!c.env.GITHUB_WEBHOOK_SECRET) {
    return c.json({ error: "webhook_not_configured" }, 503);
  }
  const raw = await c.req.text();
  const ok = await verifySignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    raw,
    c.req.header("X-Hub-Signature-256") ?? null
  );
  if (!ok) return c.json({ error: "bad_signature" }, 401);

  const event = c.req.header("X-GitHub-Event") ?? "";
  const applicationsRepo = c.env.APPLICATIONS_REPO ?? "applications";

  if (event === "ping") {
    return c.json({ ok: true, pong: true });
  }

  if (event !== "issues") {
    // Acknowledge but ignore — keeps GitHub from retrying.
    return c.json({ ok: true, ignored: event });
  }

  let payload: IssueEvent;
  try {
    payload = JSON.parse(raw) as IssueEvent;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Only act on label changes in the applications repo.
  if (
    payload.action !== "labeled" ||
    payload.repository.name !== applicationsRepo ||
    !payload.label
  ) {
    return c.json({ ok: true, ignored: payload.action });
  }

  const label = payload.label.name.toLowerCase();
  if (label !== "approved" && label !== "rejected") {
    return c.json({ ok: true, ignored: label });
  }

  const app = await c.env.DB.prepare(
    `SELECT id, user_id, status FROM applications WHERE github_issue = ?`
  )
    .bind(payload.issue.number)
    .first<{ id: string; user_id: string; status: string }>();
  if (!app) {
    return c.json({ ok: true, ignored: "unknown_issue", issue: payload.issue.number });
  }
  if (app.status !== "pending") {
    return c.json({ ok: true, ignored: "already_processed", current: app.status });
  }

  const newStatus = label === "approved" ? "approved" : "rejected";
  const now = Date.now();

  // Best-effort: link the action to the curator's internal user_id by
  // looking up their GitHub login. Falls back to NULL if they've never
  // signed in to the platform (rare for curators, but possible).
  const reviewer = await c.env.DB.prepare(
    `SELECT id FROM users WHERE github_login = ?`
  )
    .bind(payload.sender.login)
    .first<{ id: string }>();

  await c.env.DB.prepare(
    `UPDATE applications
       SET status = ?, reviewed_at = ?, reviewed_by = ?
     WHERE id = ?`
  )
    .bind(newStatus, now, reviewer?.id ?? null, app.id)
    .run();

  if (newStatus === "approved") {
    // Upgrade role only if the user hasn't already been promoted higher.
    await c.env.DB.prepare(
      `UPDATE users SET role = 'artist'
       WHERE id = ? AND role IN ('collector')`
    )
      .bind(app.user_id)
      .run();
    // Seed an artists row so the artist appears on /artists immediately.
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO artists (id, user_id, slug, status, approved_at)
       SELECT ?, ?, a.artist_slug, 'approved', ?
       FROM applications a WHERE a.id = ?`
    )
      .bind(crypto.randomUUID(), app.user_id, now, app.id)
      .run();
  }

  await audit(c.env, null, `application.${newStatus}`, app.id, {
    issue: payload.issue.number,
    by: payload.sender.login,
  });

  return c.json({ ok: true, application_id: app.id, status: newStatus });
});
