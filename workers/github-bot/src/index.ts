/**
 * GeneratedArt GitHub App webhook handler.
 *
 * Verifies HMAC signature, then routes:
 *   - issues.labeled (label='approved' on GeneratedArt/applications)
 *       → flip artists.status='approved' + promote user role + close issue
 *   - workflow_run.completed for validate-bundle.yml
 *       → record latest validation status on the project (kept in audit_log)
 *   - release.published on GeneratedArt/art-<slug>
 *       → POST /projects/:slug/publish on the API with the release tag
 */
import { Hono } from "hono";

export interface Env {
  DB: D1Database;
  PIN_QUEUE: Queue;
  ENVIRONMENT: string;
  GITHUB_ORG: string;
  API_BASE_URL: string;
  // Secrets
  GITHUB_WEBHOOK_SECRET?: string;
  INTERNAL_BOT_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

async function verifySignature(
  secret: string,
  payload: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice(7);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++)
    diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

app.get("/", (c) => c.json({ service: "github-bot", env: c.env.ENVIRONMENT }));

app.post("/webhook", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  const sig = c.req.header("x-hub-signature-256") ?? null;
  const event = c.req.header("x-github-event") ?? "unknown";
  const raw = await c.req.text();
  if (!secret || !(await verifySignature(secret, raw, sig))) {
    return c.json({ error: "bad_signature" }, 401);
  }
  const payload = JSON.parse(raw) as Record<string, any>;

  switch (event) {
    case "ping":
      return c.json({ pong: true });
    case "issues":
      return c.json(await handleIssue(c.env, payload));
    case "release":
      return c.json(await handleRelease(c.env, payload));
    case "workflow_run":
      return c.json(await handleWorkflowRun(c.env, payload));
    case "pull_request":
      return c.json({ received: "pull_request", action: payload.action });
    default:
      return c.json({ received: event });
  }
});

// ---------- handlers ----------

async function handleIssue(env: Env, payload: any) {
  if (payload.action !== "labeled") return { skipped: payload.action };
  const repoName = payload.repository?.name as string | undefined;
  if (repoName !== "applications") return { skipped: "wrong_repo" };
  const label = payload.label?.name as string | undefined;
  if (label !== "approved") return { skipped: `label:${label}` };

  // Parse slug out of the issue title `Artist application: <slug>`.
  const title = (payload.issue?.title as string) ?? "";
  const m = title.match(/Artist application:\s*([a-z0-9-]{3,40})/i);
  if (!m) return { skipped: "title_unparseable" };
  const slug = m[1].toLowerCase();
  const issueNumber = payload.issue?.number as number;

  const artist = await env.DB.prepare(
    `SELECT user_id, status FROM artists WHERE slug = ?`
  )
    .bind(slug)
    .first<{ user_id: string; status: string }>();
  if (!artist) return { skipped: "artist_not_found", slug };
  if (artist.status === "approved") return { skipped: "already_approved", slug };

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE artists SET status = 'approved', approved_at = ? WHERE slug = ?`
    ).bind(Date.now(), slug),
    env.DB.prepare(
      `UPDATE users SET role = CASE WHEN role = 'collector' THEN 'artist' ELSE role END
       WHERE id = ?`
    ).bind(artist.user_id),
    env.DB.prepare(
      `INSERT INTO audit_log (actor_user_id, action, subject, details_json, created_at)
       VALUES (NULL, 'artist.approve.webhook', ?, ?, ?)`
    ).bind(slug, JSON.stringify({ issue: issueNumber }), Date.now()),
  ]);
  return { ok: true, slug, promoted_user: artist.user_id };
}

async function handleRelease(env: Env, payload: any) {
  if (payload.action !== "published") return { skipped: payload.action };
  const repoName = payload.repository?.name as string | undefined;
  if (!repoName?.startsWith("art-")) return { skipped: "not_art_repo" };
  const slug = repoName.slice(4);
  const tag = payload.release?.tag_name as string | undefined;
  if (!tag) return { skipped: "no_tag" };

  // Read the bundle CID out of the release body. release.yml writes a line
  // like `bundle_cid: bafy...` into the release notes after pinning.
  const body = (payload.release?.body as string) ?? "";
  const cidMatch = body.match(/bundle_cid:\s*([A-Za-z0-9]+)/);
  if (!cidMatch) return { skipped: "no_cid_in_release_body" };
  const bundleCid = cidMatch[1];
  const metaMatch = body.match(/metadata_cid:\s*([A-Za-z0-9]+)/);

  if (!env.INTERNAL_BOT_TOKEN) return { skipped: "no_internal_token" };
  const res = await fetch(`${env.API_BASE_URL}/projects/${slug}/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.INTERNAL_BOT_TOKEN,
    },
    body: JSON.stringify({
      bundle_cid: bundleCid,
      release_tag: tag,
      metadata_cid: metaMatch?.[1],
    }),
  });
  return { ok: res.ok, status: res.status, slug, tag };
}

async function handleWorkflowRun(env: Env, payload: any) {
  if (payload.action !== "completed") return { skipped: payload.action };
  const wf = payload.workflow_run;
  if (!wf || wf.name !== "validate-bundle") return { skipped: "wrong_workflow" };
  const repoName = payload.repository?.name as string | undefined;
  if (!repoName?.startsWith("art-")) return { skipped: "not_art_repo" };
  const slug = repoName.slice(4);
  await env.DB.prepare(
    `INSERT INTO audit_log (actor_user_id, action, subject, details_json, created_at)
     VALUES (NULL, 'project.validate', ?, ?, ?)`
  )
    .bind(
      slug,
      JSON.stringify({
        conclusion: wf.conclusion,
        run_url: wf.html_url,
        head_sha: wf.head_sha,
      }),
      Date.now()
    )
    .run();
  return { ok: true, slug, conclusion: wf.conclusion };
}

export default app;
