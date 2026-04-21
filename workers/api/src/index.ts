/**
 * GeneratedArt API Worker
 * Hono on Cloudflare Workers. D1 + KV + R2 + Queues.
 *
 * NOTE: This is the scaffold. Endpoints return stubs; wire real implementations
 * incrementally per MVP step order in the spec.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ulid } from "ulid";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  ASSETS: R2Bucket;
  RENDER_QUEUE: Queue;
  PIN_QUEUE: Queue;
  ENVIRONMENT: string;
  SITE_ORIGIN: string;
  IPFS_GATEWAY: string;
  GITHUB_ORG: string;
  CHAIN_ID: string;
  // Secrets (set with `wrangler secret put`):
  // GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_OAUTH_CLIENT_ID,
  // GITHUB_OAUTH_CLIENT_SECRET, PINATA_JWT, WEB3_STORAGE_TOKEN,
  // STEWARD_RELAYER_PRIVATE_KEY, ETH_RPC_URL
}

type Variables = {
  userId?: string;
  sessionToken?: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = [c.env.SITE_ORIGIN, "http://localhost:4000", "http://localhost:4321"];
      return allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
  })
);

// ---------- Health & root ----------
app.get("/", (c) =>
  c.json({
    service: "generatedart-api",
    version: "0.1.0",
    environment: c.env.ENVIRONMENT,
  })
);

app.get("/health", async (c) => {
  let db = "unknown";
  try {
    await c.env.DB.prepare("SELECT 1").first();
    db = "ok";
  } catch (err) {
    db = `error: ${(err as Error).message}`;
  }
  return c.json({ status: "ok", db, time: Date.now() });
});

// ---------- Session middleware ----------
async function loadSession(c: any, next: any) {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const userId = await c.env.SESSIONS.get(`session:${token}`);
    if (userId) {
      c.set("userId", userId);
      c.set("sessionToken", token);
    }
  }
  await next();
}

function requireAuth(c: any, next: any) {
  if (!c.get("userId")) return c.json({ error: "unauthorized" }, 401);
  return next();
}

app.use("/me", loadSession);
app.use("/artists/*", loadSession);
app.use("/projects/*", loadSession);
app.use("/editions/*", loadSession);
app.use("/galleries/*", loadSession);
app.use("/owners/*", loadSession);

// ---------- Auth ----------
app.post("/auth/github/callback", async (c) => {
  // TODO: exchange OAuth code → access token → fetch user → upsert → mint session.
  return c.json({ error: "not_implemented", step: "github-oauth-exchange" }, 501);
});

app.post("/auth/siwe/verify", async (c) => {
  // TODO: verify SIWE message + signature with `siwe` package, upsert wallet user, mint session.
  return c.json({ error: "not_implemented", step: "siwe-verify" }, 501);
});

app.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const user = await c.env.DB.prepare(
    "SELECT id, github_login, wallet_address, display_name, role FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();
  if (!user) return c.json({ error: "user_not_found" }, 404);
  return c.json({ user });
});

// ---------- Artists ----------
app.post("/artists/apply", requireAuth, async (c) => {
  // TODO: validate body, write to `artists` (status=pending), open issue in GeneratedArt/applications.
  return c.json({ error: "not_implemented", step: "artist-apply" }, 501);
});

app.get("/artists/:slug", async (c) => {
  const slug = c.req.param("slug");
  const artist = await c.env.DB.prepare(
    `SELECT a.*, u.display_name, u.bio, u.avatar_r2_key
     FROM artists a JOIN users u ON u.id = a.user_id
     WHERE a.slug = ?`
  )
    .bind(slug)
    .first();
  if (!artist) return c.json({ error: "not_found" }, 404);
  return c.json({ artist });
});

app.patch("/artists/:slug", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "artist-update" }, 501)
);

app.post("/artists/:slug/approve", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "artist-approve" }, 501)
);

// ---------- Projects ----------
app.post("/projects", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "project-create-and-repo-init" }, 501)
);

app.get("/projects", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, title, description, edition_size, minted_count, status, contract_address
     FROM projects WHERE status IN ('live', 'sold_out')
     ORDER BY created_at DESC LIMIT 100`
  ).all();
  return c.json({ projects: rows.results ?? [] });
});

app.get("/projects/:slug", async (c) => {
  const slug = c.req.param("slug");
  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE slug = ?"
  )
    .bind(slug)
    .first();
  if (!project) return c.json({ error: "not_found" }, 404);
  return c.json({ project });
});

app.post("/projects/:slug/submit", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "project-submit-pr" }, 501)
);

app.post("/projects/:slug/approve", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "project-approve-merge-tag-pin-deploy" }, 501)
);

app.post("/projects/:slug/archive", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "project-archive" }, 501)
);

app.get("/projects/:slug/mint-params", async (c) => {
  const slug = c.req.param("slug");
  const project = await c.env.DB.prepare(
    "SELECT contract_address, price_wei FROM projects WHERE slug = ? AND status = 'live'"
  )
    .bind(slug)
    .first<{ contract_address: string; price_wei: string }>();
  if (!project?.contract_address)
    return c.json({ error: "not_live" }, 404);
  return c.json({
    contract: project.contract_address,
    price_wei: project.price_wei,
    chain_id: Number(c.env.CHAIN_ID),
  });
});

app.post("/projects/:slug/preview", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "queue-render-preview" }, 501)
);

// ---------- Editions ----------
app.get("/editions/:contract/:tokenId", async (c) => {
  const contract = c.req.param("contract").toLowerCase();
  const tokenId = c.req.param("tokenId");
  const edition = await c.env.DB.prepare(
    "SELECT * FROM editions WHERE id = ?"
  )
    .bind(`${contract}:${tokenId}`)
    .first();
  if (!edition) return c.json({ error: "not_found" }, 404);
  return c.json({ edition });
});

app.get("/owners/:address/editions", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const rows = await c.env.DB.prepare(
    "SELECT * FROM editions WHERE owner_address = ? ORDER BY minted_at DESC"
  )
    .bind(address)
    .all();
  return c.json({ editions: rows.results ?? [] });
});

// ---------- Galleries ----------
app.post("/galleries", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "gallery-create" }, 501)
);

app.post("/galleries/:slug/exhibitions", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "exhibition-create" }, 501)
);

// ---------- Physical bridge ----------
app.post("/editions/:id/request-physical", requireAuth, (c) =>
  c.json({ error: "not_implemented", step: "physical-request" }, 501)
);

// ---------- Audit log helper (use from every mutating endpoint once implemented) ----------
export async function audit(
  env: Env,
  actorUserId: string | null,
  action: string,
  subject: string | null,
  details: unknown
) {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor_user_id, action, subject, details_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(actorUserId, action, subject, JSON.stringify(details), Date.now())
    .run();
}

export { ulid };
export default app;
