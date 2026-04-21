/**
 * GitHub App webhook handler.
 * Verifies signature, routes events:
 *   - issues.labeled (label='approved' on GeneratedArt/applications) → flip artists.status='approved'
 *   - pull_request.merged on GeneratedArt/art-* with 'release' label → tag, pin, enqueue deploy
 *   - workflow_run.completed for validate-bundle.yml → store result
 */
import { Hono } from "hono";

export interface Env {
  DB: D1Database;
  PIN_QUEUE: Queue;
  ENVIRONMENT: string;
  GITHUB_ORG: string;
  // Secrets:
  // GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
}

const app = new Hono<{ Bindings: Env }>();

async function verifySignature(secret: string, payload: string, signatureHeader: string | null) {
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
  // constant-time compare
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

app.get("/", (c) => c.json({ service: "github-bot", env: c.env.ENVIRONMENT }));

app.post("/webhook", async (c) => {
  const secret = (c.env as any).GITHUB_WEBHOOK_SECRET as string | undefined;
  const sig = c.req.header("x-hub-signature-256") ?? null;
  const event = c.req.header("x-github-event") ?? "unknown";
  const raw = await c.req.text();
  if (!secret || !(await verifySignature(secret, raw, sig))) {
    return c.json({ error: "bad_signature" }, 401);
  }
  const payload = JSON.parse(raw);

  switch (event) {
    case "ping":
      return c.json({ pong: true });
    case "issues":
      // TODO: handle labeled 'approved' on applications repo.
      return c.json({ received: "issues", action: payload.action });
    case "pull_request":
      // TODO: handle merged + label='release' on art-* repos.
      return c.json({ received: "pull_request", action: payload.action });
    case "workflow_run":
      return c.json({ received: "workflow_run", status: payload.workflow_run?.status });
    default:
      return c.json({ received: event });
  }
});

export default app;
