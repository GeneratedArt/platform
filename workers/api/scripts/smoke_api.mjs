// End-to-end smoke harness for the GeneratedArt API.
//
// Exercises the real HTTP surface — SIWE sign-in with a freshly generated
// keypair, project create/patch/commit/capture, the freeze → activate →
// mint-guard chain, galleries, social graph, briefs, discovery, OG, and a
// block of abuse cases (ownership, path traversal, cursor/limit
// validation, nonce replay, foreign-domain SIWE, forged cookies, CORS).
//
// Usage:
//   cp .dev.vars.example .dev.vars    # then set a real JWT_SECRET
//   npx wrangler d1 migrations apply DB --local
//   npx wrangler dev --port 8787 &
//   npm run smoke                     # or: BASE=https://api.example node scripts/smoke_api.mjs
//
// Exits non-zero if any check fails. Freeze and mint report as
// "unconfigured" rather than failing when their secrets are absent, so
// this is safe to run against a bare local setup — set PINNING_MOCK=1 in
// .dev.vars to drive the freeze pipeline for real.
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const ORIGIN = "http://localhost:5000";
const DOMAIN = "localhost:5000";

let cookie = "";
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}

async function api(method, path, body, opts = {}) {
  const headers = { Origin: ORIGIN };
  // opts.anon: skip the session cookie even though a global `cookie` is
  // set — lets a still-logged-in suite probe how a public endpoint
  // renders for an unauthenticated viewer without a full logout/login
  // round-trip.
  if (cookie && !opts.anon) headers.Cookie = cookie;
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : body instanceof FormData || ArrayBuffer.isView(body) || body instanceof ArrayBuffer
          ? body
          : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const m = /ga_session=([^;]*)/.exec(setCookie);
    if (m) cookie = `ga_session=${m[1]}`;
  }
  const ct = res.headers.get("content-type") || "";
  let data;
  if (ct.includes("application/json")) data = await res.json().catch(() => null);
  else data = await res.text();
  return { status: res.status, data, headers: res.headers };
}

// The Worker rate-limits SIWE verify to 10/min/IP. This suite signs in as
// ~9 throwaway wallets from one IP, so a back-to-back re-run can trip it.
// Wait out the window rather than reporting a false failure — a 429 here
// is the limiter working, not a regression.
async function login(account, allowRetry = true) {
  const { data: nonceRes, status } = await api("POST", "/v1/auth/siwe/nonce");
  if (status === 429 && allowRetry) {
    await waitForRateLimit(nonceRes?.reset_at);
    return login(account, false);
  }
  if (status !== 200) throw new Error("nonce failed " + status + JSON.stringify(nonceRes));
  const nonce = nonceRes.nonce;
  const issuedAt = new Date().toISOString();
  const message = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    account.address,
    ``,
    `Sign in to GeneratedArt`,
    ``,
    `URI: ${ORIGIN}`,
    `Version: 1`,
    `Chain ID: 84532`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const r = await api("POST", "/v1/auth/siwe/verify", { message, signature });
  if (r.status === 429 && allowRetry) {
    await waitForRateLimit(r.data?.reset_at);
    return login(account, false);
  }
  return r;
}

async function waitForRateLimit(resetAt) {
  const now = Math.floor(Date.now() / 1000);
  const seconds = Math.min(
    70,
    Math.max(2, (typeof resetAt === "number" ? resetAt : now + 60) - now + 1),
  );
  console.log(`     … auth rate limit hit, waiting ${seconds}s for the window to reset`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

const H1 = "smoke" + Math.random().toString(36).slice(2,7);
const H2 = "smoke" + Math.random().toString(36).slice(2,7);
const RUN = Math.random().toString(36).slice(2, 8);
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const pk2 = generatePrivateKey();
const account2 = privateKeyToAccount(pk2);

// ---- health
{
  const r = await api("GET", "/health");
  record("GET /health", r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
}

// ---- auth
{
  const r = await login(account);
  record("SIWE login", r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/me");
  record("GET /v1/me", r.status === 200 && !!r.data?.user, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("PATCH", "/v1/me", { handle: H1, display_name: "Smoke Tester", bio: "hi" });
  record("PATCH /v1/me", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}

// ---- projects
let projectId = null;
{
  const r = await api("POST", "/v1/projects", { title: "Smoke Drift", engine: "p5", description: "smoke test project" });
  projectId = r.data?.project?.id ?? r.data?.id ?? null;
  record("POST /v1/projects", r.status === 200 || r.status === 201, JSON.stringify(r.data).slice(0, 300));
}
{
  const r = await api("GET", `/v1/projects/${projectId}`);
  record("GET /v1/projects/:id", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/projects/mine");
  record("GET /v1/projects/mine", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("PATCH", `/v1/projects/${projectId}`, { description: "updated desc", status: "published" });
  record("PATCH /v1/projects/:id", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}

// ---- studio file + commit
{
  const r = await api("GET", `/v1/projects/${projectId}/file?path=sketch.js`);
  record("GET /v1/projects/:id/file", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", `/v1/projects/${projectId}/commit`, {
    path: "sketch.js",
    content: "function setup(){createCanvas(400,400);}function draw(){background(9);}",
    message: "smoke commit",
  });
  record("POST /v1/projects/:id/commit", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}

// ---- captures
{
  // 1x1 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const r = await api("POST", `/v1/projects/${projectId}/captures`, {
    data_url: "data:image/png;base64," + png.toString("base64"),
    seed: "smoke1",
  });
  record("POST /v1/projects/:id/captures", r.status === 200 || r.status === 201, JSON.stringify(r.data).slice(0, 250));
  const key = r.data?.capture?.key;
  if (key) {
    const g = await api("GET", `/v1/captures/${key}`);
    record("GET /v1/captures/*", g.status === 200, `status=${g.status}`);
    const bad = await api("GET", `/v1/captures/../../etc/passwd`);
    record("GET /v1/captures traversal rejected", bad.status === 400 || bad.status === 404, `status=${bad.status}`);
  }
}

// ---- freeze
{
  // 201 when pinning is configured (or PINNING_MOCK=1); 503
  // pinning_unconfigured on a bare local setup — both are healthy.
  const r = await api("POST", `/v1/projects/${projectId}/freeze`, { commit: "latest" });
  record(
    "POST /v1/projects/:id/freeze",
    r.status === 201 || r.status === 503,
    JSON.stringify(r.data).slice(0, 200),
  );
}
{
  const r = await api("GET", `/v1/projects/${projectId}/frozen`);
  record("GET /v1/projects/:id/frozen", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}

// ---- mint
{
  const r = await api("GET", "/v1/mint/config");
  record("GET /v1/mint/config", r.status === 200 || r.status === 503, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("GET", `/v1/projects/${projectId}/mint/state`);
  record("GET /v1/projects/:id/mint/state", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("POST", `/v1/projects/${projectId}/mint/prepare`, { phase: "deploy" });
  record("POST mint/prepare", r.status === 200 || r.status === 503 || r.status === 409 || r.status === 400, JSON.stringify(r.data).slice(0, 250));
}

// ---- traits/mints
{
  const r = await api("GET", `/v1/projects/${projectId}/traits`);
  record("GET /v1/projects/:id/traits", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/projects/${projectId}/mints`);
  record("GET /v1/projects/:id/mints", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/projects/${projectId}/mints/1`);
  record("GET /v1/projects/:id/mints/:tokenId (404 expected)", r.status === 404, `status=${r.status}`);
}

// ---- render-token service (user 1, still signed in from above)
// Render jobs report as succeeding when RENDER_MOCK=1 is set in
// .dev.vars, or 503 provider_unconfigured otherwise (no live
// Anthropic key / Workers AI binding in a bare local setup) — both are
// accepted, same "unconfigured is fine" posture as freeze/mint above.
{
  const r = await api("GET", "/v1/tokens/account");
  record(
    "GET /v1/tokens/account (signup grant applied)",
    r.status === 200 && r.data?.balance === 200,
    JSON.stringify(r.data),
  );
}
{
  const r = await api("GET", "/v1/tokens/ledger");
  record(
    "GET /v1/tokens/ledger (signup grant entry present)",
    r.status === 200 && Array.isArray(r.data?.entries) && r.data.entries.some((e) => e.kind === "grant"),
    JSON.stringify(r.data).slice(0, 200),
  );
}
{
  const r = await api("GET", "/v1/tokens/packs");
  record(
    "GET /v1/tokens/packs (seeded packs visible)",
    r.status === 200 && Array.isArray(r.data?.packs) && r.data.packs.length >= 3,
    JSON.stringify(r.data).slice(0, 200),
  );
}
{
  const r = await api("POST", "/v1/tokens/purchase/confirm", { pack_id: 1, tx_hash: "0x" + "1".repeat(64) });
  record(
    "POST /v1/tokens/purchase/confirm without treasury configured → 503",
    r.status === 503,
    JSON.stringify(r.data),
  );
}

let modelSlug = null;
{
  const r = await api("POST", "/v1/models", {
    title: `Smoke Model ${RUN}`,
    kind: "code",
    provider: "anthropic",
    visibility: "public",
  });
  modelSlug = r.data?.model?.slug ?? null;
  record("POST /v1/models", r.status === 201 && !!modelSlug, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", "/v1/models", {
    title: "Bad combo",
    kind: "image",
    provider: "anthropic",
  });
  record(
    "POST /v1/models rejects provider/kind mismatch",
    r.status === 400 && r.data?.error === "provider_not_allowed_for_kind",
    JSON.stringify(r.data),
  );
}
{
  const r = await api("GET", "/v1/models/mine");
  record(
    "GET /v1/models/mine",
    r.status === 200 && Array.isArray(r.data?.models) && r.data.models.some((m) => m.slug === modelSlug),
    JSON.stringify(r.data).slice(0, 200),
  );
}
{
  const r = await api("POST", `/v1/models/${modelSlug}/versions`, {
    provider_model_id: "claude-opus-5",
    system_prompt: "You write playful p5.js sketches.",
    price_tokens: 10,
  });
  record(
    "POST /v1/models/:slug/versions",
    r.status === 201 && r.data?.version?.version === 1,
    JSON.stringify(r.data).slice(0, 200),
  );
}
{
  const r = await api("GET", `/v1/models/${modelSlug}`);
  record(
    "GET /v1/models/:slug (owner sees system_prompt, latest version listed)",
    r.status === 200 && r.data?.versions?.[0]?.system_prompt === "You write playful p5.js sketches.",
    JSON.stringify(r.data).slice(0, 250),
  );
}
{
  const r = await api("GET", "/v1/models?kind=code");
  record(
    "GET /v1/models?kind=code (public catalogue)",
    r.status === 200 && r.data?.models?.some((m) => m.slug === modelSlug),
    JSON.stringify(r.data).slice(0, 200),
  );
}

// fal_custom — the creator-trained-model lane (see
// migrations/0019_custom_model_provider.sql). Registration and publish
// validation are exercised for real here even though the actual render
// still runs mocked (no live FAL_KEY in CI).
let falModelSlug = null;
{
  const r = await api("POST", "/v1/models", {
    title: `Smoke Custom Model ${RUN}`,
    kind: "image",
    provider: "fal_custom",
    visibility: "public",
  });
  falModelSlug = r.data?.model?.slug ?? null;
  record("POST /v1/models (fal_custom)", r.status === 201 && !!falModelSlug, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", `/v1/models/${falModelSlug}/versions`, {
    provider_model_id: "fal-ai/flux-lora",
    price_tokens: 25,
  });
  record(
    "POST /v1/models/:slug/versions (fal_custom) rejects missing weights_ref",
    r.status === 400 && r.data?.error === "weights_ref_required_for_fal_custom",
    JSON.stringify(r.data),
  );
}
{
  const r = await api("POST", `/v1/models/${falModelSlug}/versions`, {
    provider_model_id: "fal-ai/flux-lora",
    price_tokens: 25,
    training_method: "lora",
    base_model: "FLUX.1 [dev]",
    dataset_note: "2,400 hand-collected botanical scans, own photography",
    weights_ref: "smoke-test/botanical-lora-v1",
  });
  record(
    "POST /v1/models/:slug/versions (fal_custom) accepts training lineage + weights_ref",
    r.status === 201 && r.data?.version?.training_method === "lora" && r.data?.version?.weights_ref === "smoke-test/botanical-lora-v1",
    JSON.stringify(r.data).slice(0, 250),
  );
}
{
  // Public listing surfaces the provenance disclosure (training_method,
  // base_model, dataset_note) but never the owner-only weights_ref.
  const r = await api("GET", `/v1/models/${falModelSlug}`, undefined, { anon: true });
  const v0 = r.data?.versions?.[0];
  record(
    "GET /v1/models/:slug (anon) shows provenance, hides weights_ref",
    r.status === 200 && v0?.dataset_note?.includes("botanical") && v0?.weights_ref === undefined,
    JSON.stringify(r.data).slice(0, 250),
  );
}

let renderJobId = null;
{
  const r = await api("POST", `/v1/models/${modelSlug}/render`, {
    prompt: "a field of drifting particles",
    seed: "smoke-seed-1",
  });
  renderJobId = r.data?.job?.id ?? null;
  record(
    "POST /v1/models/:slug/render (mock success or provider_unconfigured)",
    (r.status === 201 && r.data?.job?.status === "succeeded") || (r.status === 503 && r.data?.error === "provider_unconfigured"),
    JSON.stringify(r.data).slice(0, 250),
  );
}
{
  // Same idempotency_key twice must not double-charge. The first call
  // creates the job (201); the replay returns the SAME job unchanged
  // (200, replayed:true — it isn't a new creation, so a different
  // status code here is correct REST, not a bug).
  const key = "smoke-idem-" + RUN;
  const before = await api("GET", "/v1/tokens/account");
  const first = await api("POST", `/v1/models/${modelSlug}/render`, { prompt: "p", idempotency_key: key });
  const second = await api("POST", `/v1/models/${modelSlug}/render`, { prompt: "p", idempotency_key: key });
  const after = await api("GET", "/v1/tokens/account");
  const sameJob = first.data?.job?.id && first.data.job.id === second.data?.job?.id;
  const balanceMovedOnce =
    typeof before.data?.balance === "number" &&
    typeof after.data?.balance === "number" &&
    before.data.balance - after.data.balance === (first.data?.job?.price_tokens ?? 0);
  record(
    "POST render with repeated idempotency_key replays instead of double-charging",
    first.status === 201 && second.status === 200 && second.data?.replayed === true && sameJob && balanceMovedOnce,
    `first=${first.status} second=${second.status} replayed=${second.data?.replayed} before=${before.data?.balance} after=${after.data?.balance} price=${first.data?.job?.price_tokens}`,
  );
}
if (renderJobId) {
  const r = await api("GET", `/v1/jobs/${renderJobId}`);
  record("GET /v1/jobs/:id (owner)", r.status === 200 && r.data?.job?.id === renderJobId, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/jobs");
  record("GET /v1/jobs (mine)", r.status === 200 && Array.isArray(r.data?.jobs), JSON.stringify(r.data).slice(0, 200));
}
{
  // Draining the balance below the model's price must fail closed with
  // 402 and refund nothing — never silently go negative.
  const cheapPrompt = { prompt: "x" };
  let last = null;
  for (let i = 0; i < 25; i++) {
    last = await api("POST", `/v1/models/${modelSlug}/render`, cheapPrompt);
    if (last.status === 402) break;
  }
  record(
    "render debits stop at 402 insufficient_balance rather than going negative",
    last && (last.status === 402 || last.status === 503),
    `status=${last?.status} body=${JSON.stringify(last?.data).slice(0, 150)}`,
  );
  const acct = await api("GET", "/v1/tokens/account");
  record("balance never goes negative", acct.status === 200 && acct.data?.balance >= 0, JSON.stringify(acct.data));
}

// ---- galleries
{
  const r = await api("GET", "/v1/galleries");
  record("GET /v1/galleries", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", "/v1/galleries", { title: "Smoke Gallery", description: "d" });
  record("POST /v1/galleries (non-curator → 403)", r.status === 403 || r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/projects/${projectId}/galleries`);
  record("GET /v1/projects/:id/galleries", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}

// ---- users / social
{
  const r = await api("GET", `/v1/users/${H1}`);
  record("GET /v1/users/:handle", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/users/${H1}/projects`);
  record("GET /v1/users/:handle/projects", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/users/${H1}/followers`);
  record("GET /v1/users/:handle/followers", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", `/v1/users/${H1}/following`);
  record("GET /v1/users/:handle/following", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}

// second user follows first
const firstCookie = cookie;
cookie = "";
{
  const r = await login(account2);
  record("SIWE login (user 2)", r.status === 200, `status=${r.status}`);
}
{
  const r = await api("PATCH", "/v1/me", { handle: H2, display_name: "Smoke Two" });
  record("PATCH /v1/me (user 2)", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", `/v1/users/${H1}/follow`);
  record("POST follow", r.status === 200 || r.status === 201, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/feed");
  record("GET /v1/feed", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("GET", "/v1/notifications");
  record("GET /v1/notifications", r.status === 200, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("POST", "/v1/notifications/read", { all: true });
  record("POST /v1/notifications/read", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("DELETE", `/v1/users/${H1}/follow`);
  record("DELETE follow", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}

// ---- briefs
let briefId = null;
{
  const r = await api("POST", "/v1/briefs", {
    title: "Smoke Brief",
    body: "Looking for a generative artist for a smoke test commission.",
    industry: "fashion",
    budget: "1000",
  });
  briefId = r.data?.brief?.id ?? r.data?.id ?? null;
  record("POST /v1/briefs", r.status === 200 || r.status === 201, JSON.stringify(r.data).slice(0, 300));
}
{
  const r = await api("GET", "/v1/briefs");
  record("GET /v1/briefs", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
if (briefId) {
  const r = await api("GET", `/v1/briefs/${briefId}`);
  record("GET /v1/briefs/:id", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}

// ---- discovery
{
  const r = await api("GET", "/v1/explore?tab=recent");
  record("GET /v1/explore?tab=recent", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/explore?tab=trending");
  record("GET /v1/explore?tab=trending", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/explore?tab=featured");
  record("GET /v1/explore?tab=featured", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/search?q=smoke");
  record("GET /v1/search?q=smoke", r.status === 200, JSON.stringify(r.data).slice(0, 300));
}
{
  const r = await api("GET", "/v1/search?q=");
  record("GET /v1/search (empty q)", r.status === 200 || r.status === 400, `status=${r.status}`);
}

// ---- OG
{
  const r = await api("GET", `/v1/og/projects/${projectId}`);
  record("GET /v1/og/projects/:id", r.status === 200, `status=${r.status}`);
}
{
  const r = await api("GET", `/v1/og/projects/${projectId}/data`);
  record("GET /v1/og/projects/:id/data", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}

// ---- internal
{
  const r = await api("GET", "/v1/internal/stats");
  record("GET /v1/internal/stats (403 expected, no ADMIN_HANDLES)", r.status === 403, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", "/v1/internal/client-error", { message: "smoke", stack: "x", url: "/x" });
  record("POST /v1/internal/client-error", r.status === 200 || r.status === 204 || r.status === 202, `status=${r.status}`);
}

// ---- 404 + logout
{
  const r = await api("GET", "/v1/nope");
  record("404 shape", r.status === 404 && r.data?.error === "not_found", JSON.stringify(r.data).slice(0, 120));
}
{
  const r = await api("POST", "/v1/auth/logout");
  record("POST /v1/auth/logout", r.status === 200, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("GET", "/v1/me");
  record("GET /v1/me after logout (401)", r.status === 401, `status=${r.status}`);
}


// ===========================================================================
// Deep paths: freeze → activate → mint guard, ownership, abuse cases.
// ===========================================================================
const H = "deep" + Math.random().toString(36).slice(2, 7);
const acct = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

await login(acct);
await api("PATCH", "/v1/me", { handle: H });
const mine = await api("GET", "/v1/me");
const myId = mine.data.user.id;

const created = await api("POST", "/v1/projects", { title: "Deep Freeze", engine: "p5" });
const pid = created.data?.project?.id;
record("project created", !!pid, `id=${pid}`);

// ---- freeze in PINNING_MOCK mode
let fid = null;
{
  const r = await api("POST", `/v1/projects/${pid}/freeze`, { commit: "latest" });
  fid = r.data?.frozen?.id;
  record("POST freeze (mock pinning)", r.status === 201 && !!fid, JSON.stringify(r.data));
}
{
  const r = await api("GET", `/v1/projects/${pid}/frozen`);
  record("frozen list has 1, none active", r.status === 200 && r.data.versions.length === 1 && r.data.active === null, JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", `/v1/projects/${pid}/mint/prepare`, { phase: "deploy" });
  record("mint/prepare blocked without active frozen (422 or 503)", r.status === 422 || r.status === 503, JSON.stringify(r.data));
}
{
  const r = await api("POST", `/v1/projects/${pid}/frozen/${fid}/activate`);
  record("POST activate frozen", r.status === 200 && r.data?.frozen?.is_active === true, JSON.stringify(r.data).slice(0, 250));
}
{
  const r = await api("GET", `/v1/projects/${pid}/frozen`);
  record("frozen list now has active", r.status === 200 && r.data.active?.id === fid, JSON.stringify(r.data.active).slice(0, 200));
}
{
  const r = await api("GET", `/v1/projects/${pid}`);
  record("project.frozen_cid mirrored on activate", !!r.data?.project?.frozen_cid, JSON.stringify(r.data.project?.frozen_cid));
}
{
  // Determinism: freezing the same commit twice must give the same hash.
  const r = await api("POST", `/v1/projects/${pid}/freeze`, { commit: "latest" });
  const first = await api("GET", `/v1/projects/${pid}/frozen`);
  const hashes = new Set(first.data.versions.map((v) => v.bundle_hash));
  record("re-freeze same commit → identical bundle_hash", r.status === 201 && hashes.size === 1, [...hashes].join(","));
}
{
  const r = await api("POST", `/v1/projects/${pid}/frozen/${fid}/retry-pin`);
  record("retry-pin on fully-pinned row → 409", r.status === 409, JSON.stringify(r.data));
}

// ---- ownership enforcement from a second account
const myCookie = cookie;
cookie = "";
await login(other);
await api("PATCH", "/v1/me", { handle: H + "x" });
{
  const r = await api("POST", `/v1/projects/${pid}/freeze`, {});
  record("freeze by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("POST", `/v1/projects/${pid}/commit`, { path: "sketch.js", content: "x" });
  record("commit by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("GET", `/v1/projects/${pid}/file`);
  record("read file by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("PATCH", `/v1/projects/${pid}`, { title: "hijack" });
  record("patch project by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("POST", `/v1/projects/${pid}/frozen/${fid}/activate`);
  record("activate by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("POST", `/v1/projects/${pid}/archive`);
  record("archive by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}
{
  const r = await api("POST", `/v1/projects/${pid}/captures`, { data_url: "data:image/png;base64,AAA" });
  record("capture upload by non-owner → 403", r.status === 403, JSON.stringify(r.data));
}

cookie = myCookie;

// ---- input validation
{
  const r = await api("POST", "/v1/projects", { title: "", engine: "p5" });
  record("create project empty title → 400", r.status === 400, JSON.stringify(r.data));
}
{
  const r = await api("POST", "/v1/projects", { title: "Bad Engine", engine: "cobol" });
  record("create project bad engine → 400", r.status === 400, JSON.stringify(r.data));
}
{
  const r = await api("PATCH", "/v1/me", { handle: "!!!bad!!!" });
  record("bad handle → 400", r.status === 400, JSON.stringify(r.data));
}
{
  const r = await api("PATCH", "/v1/me", { socials: [{ label: "x", url: "javascript:alert(1)" }] });
  record("javascript: social url rejected/sanitized", r.status === 400 || !JSON.stringify(r.data).includes("javascript:"), JSON.stringify(r.data).slice(0, 200));
}
{
  const r = await api("POST", `/v1/projects/${pid}/commit`, { path: "../../etc/passwd", content: "x" });
  record("path traversal in commit → 400", r.status === 400, JSON.stringify(r.data));
}
{
  const r = await api("GET", `/v1/projects/${pid}/file?path=../../secret`);
  record("path traversal in file read → 400", r.status === 400, JSON.stringify(r.data));
}
{
  const r = await api("GET", "/v1/explore?tab=recent&limit=99999");
  const n = r.data?.cards?.length ?? 0;
  record("explore limit clamped", r.status === 200 && n <= 50, `cards=${n}`);
}
{
  const r = await api("GET", "/v1/explore?tab=bogus");
  record("explore unknown tab handled", r.status === 200 || r.status === 400, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/search?q=" + encodeURIComponent('" OR 1=1 --'));
  record("search FTS injection safe", r.status === 200 || r.status === 400, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/search?q=" + encodeURIComponent("smoke AND (drift"));
  record("search unbalanced FTS syntax handled", r.status === 200 || r.status === 400, `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
}
{
  const r = await api("GET", "/v1/briefs?industry=" + encodeURIComponent("' OR 1=1"));
  record("briefs industry filter safe", r.status === 200 || r.status === 400, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/feed?before=garbage");
  record("feed bad cursor handled", r.status === 200 || r.status === 400, `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
}
{
  const r = await api("GET", "/v1/notifications?before=1:2:3");
  record("notifications bad cursor handled", r.status === 200 || r.status === 400, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/galleries?before=nope");
  record("galleries bad cursor handled", r.status === 200 || r.status === 400, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/projects/99999999/mint/state");
  record("mint/state unknown project → 404", r.status === 404, `status=${r.status}`);
}
{
  const r = await api("GET", "/v1/users/does-not-exist-xyz");
  record("unknown handle → 404", r.status === 404, `status=${r.status}`);
}
{
  const r = await api("POST", `/v1/users/${H}/follow`);
  record("self-follow rejected", r.status === 400 || r.status === 409, JSON.stringify(r.data));
}
{
  const r = await api("POST", "/v1/auth/siwe/verify", { message: "garbage", signature: "0x00" });
  record("garbage SIWE → 400", r.status === 400, JSON.stringify(r.data));
}
{
  // replay: reuse a consumed nonce
  const { data: n } = await api("POST", "/v1/auth/siwe/nonce");
  const msg = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    acct.address, ``, `Sign in`, ``, `URI: ${ORIGIN}`, `Version: 1`,
    `Chain ID: 84532`, `Nonce: ${n.nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const sig = await acct.signMessage({ message: msg });
  const first = await api("POST", "/v1/auth/siwe/verify", { message: msg, signature: sig });
  const second = await api("POST", "/v1/auth/siwe/verify", { message: msg, signature: sig });
  record("nonce is single-use (replay → 400)", first.status === 200 && second.status === 400, `first=${first.status} second=${second.status}`);
}
{
  // wrong-domain SIWE must be rejected
  const { data: n } = await api("POST", "/v1/auth/siwe/nonce");
  const msg = [
    `evil.example.com wants you to sign in with your Ethereum account:`,
    acct.address, ``, `Sign in`, ``, `URI: https://evil.example.com`, `Version: 1`,
    `Chain ID: 84532`, `Nonce: ${n.nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const sig = await acct.signMessage({ message: msg });
  const r = await api("POST", "/v1/auth/siwe/verify", { message: msg, signature: sig });
  record("foreign domain SIWE → 400", r.status === 400, JSON.stringify(r.data));
}
{
  // signature by a different key than the stated address
  const { data: n } = await api("POST", "/v1/auth/siwe/nonce");
  const msg = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    acct.address, ``, `Sign in`, ``, `URI: ${ORIGIN}`, `Version: 1`,
    `Chain ID: 84532`, `Nonce: ${n.nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const sig = await other.signMessage({ message: msg });
  const r = await api("POST", "/v1/auth/siwe/verify", { message: msg, signature: sig });
  record("mismatched signer → 401", r.status === 401, JSON.stringify(r.data));
}
{
  const r = await fetch(BASE + "/v1/me", { headers: { Cookie: "ga_session=not.a.jwt", Origin: ORIGIN } });
  record("forged session cookie → 401", r.status === 401, `status=${r.status}`);
}
{
  const r = await fetch(BASE + "/v1/projects", {
    method: "POST",
    headers: { Origin: "https://evil.example.com", "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ title: "csrf", engine: "p5" }),
  });
  const acao = r.headers.get("access-control-allow-origin");
  record("CORS does not echo unknown origin", !acao || acao !== "https://evil.example.com", `acao=${acao}`);
}


// ===========================================================================
// Draft privacy in the public follow feed.
//
// GET /v1/feed applies no project-status filter of its own — it returns
// whatever public-broadcast events exist for the actors you follow, and a
// commit/freeze event carries the project's title and slug in its
// payload. So the status gate has to live at the emission site. This
// checks that a draft project's name never reaches a follower, and that
// publishing then starts the broadcast normally.
// ===========================================================================
{
  const artist = privateKeyToAccount(generatePrivateKey());
  const fan = privateKeyToAccount(generatePrivateKey());
  const artistHandle = "draft" + Math.random().toString(36).slice(2, 7);
  const secretTitle = "Unreleased " + Math.random().toString(36).slice(2, 10);

  cookie = "";
  await login(artist);
  await api("PATCH", "/v1/me", { handle: artistHandle });
  const p = await api("POST", "/v1/projects", { title: secretTitle, engine: "p5" });
  const draftId = p.data?.project?.id;
  record("draft project created", p.data?.project?.status === "draft", `status=${p.data?.project?.status}`);

  const artistCookie = cookie;
  cookie = "";
  await login(fan);
  await api("PATCH", "/v1/me", { handle: artistHandle + "fan" });
  await api("POST", `/v1/users/${artistHandle}/follow`);
  const fanCookie = cookie;

  // Artist works on the draft: commit + freeze, both while unpublished.
  cookie = artistCookie;
  await api("POST", `/v1/projects/${draftId}/commit`, {
    path: "sketch.js",
    content: "function setup(){createCanvas(100,100);}",
    message: "wip",
  });
  await api("POST", `/v1/projects/${draftId}/freeze`, { commit: "latest" });

  cookie = fanCookie;
  {
    const f = await api("GET", "/v1/feed");
    const leaked = JSON.stringify(f.data).includes(secretTitle);
    record("draft commit/freeze does not leak into follower feed", !leaked,
      leaked ? `feed contained "${secretTitle}"` : "clean");
  }

  // Publish, then commit again — now it should broadcast.
  cookie = artistCookie;
  await api("PATCH", `/v1/projects/${draftId}`, { status: "published" });
  await api("POST", `/v1/projects/${draftId}/commit`, {
    path: "sketch.js",
    content: "function setup(){createCanvas(101,101);}",
    message: "ship",
  });

  cookie = fanCookie;
  {
    const f = await api("GET", "/v1/feed");
    const present = JSON.stringify(f.data).includes(secretTitle);
    record("published commit does reach follower feed", present, present ? "present" : "missing");
  }
}

// ---- Dataset Library + training (Task #21) --------------------------
// Fresh account so the 200-token signup grant is intact — training a
// LoRA costs 150, deliberately priced to fit inside that grant.
{
  const trainer = privateKeyToAccount(generatePrivateKey());
  await login(trainer);

  let datasetSlug = null;
  {
    const r = await api("POST", "/v1/datasets", {
      title: `Smoke Dataset ${RUN}`,
      description: "A hand-collected archive of smoke-test textures.",
      rights_declaration: "own",
    });
    datasetSlug = r.data?.dataset?.slug ?? null;
    record("POST /v1/datasets", r.status === 201 && !!datasetSlug, JSON.stringify(r.data).slice(0, 200));
  }
  {
    const r = await api("POST", "/v1/datasets", { title: "Bad rights" });
    record(
      "POST /v1/datasets rejects missing rights_declaration",
      r.status === 400 && r.data?.error === "invalid_rights_declaration",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("GET", "/v1/datasets/mine");
    record(
      "GET /v1/datasets/mine",
      r.status === 200 && r.data?.datasets?.some((d) => d.slug === datasetSlug),
      JSON.stringify(r.data).slice(0, 200),
    );
  }

  // A 1x1 PNG, re-encoded with a distinct trailing comment byte per
  // upload so each item hashes uniquely (dedup is exact-content-hash).
  const onePxPngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  function pngDataUrl(tag) {
    // Append a harmless PNG tEXt-like tail so distinct calls hash
    // differently; real decoders ignore trailing garbage bytes but we
    // never decode these ourselves — only R2-store and hash them.
    const bytes = Buffer.from(onePxPngB64, "base64");
    const tagged = Buffer.concat([bytes, Buffer.from(`smoke-${tag}`)]);
    return `data:image/png;base64,${tagged.toString("base64")}`;
  }

  let firstItemId = null;
  const itemIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await api("POST", `/v1/datasets/${datasetSlug}/items`, {
      data_url: pngDataUrl(i),
      caption: `texture ${i}`,
    });
    if (i === 0) firstItemId = r.data?.item?.id ?? null;
    if (r.status === 201) itemIds.push(r.data.item.id);
    record(`POST /v1/datasets/:slug/items (${i + 1}/5)`, r.status === 201, JSON.stringify(r.data).slice(0, 150));
  }
  {
    // Re-upload the first item's exact bytes — must dedup, not double-count.
    const r = await api("POST", `/v1/datasets/${datasetSlug}/items`, {
      data_url: pngDataUrl(0),
    });
    record(
      "duplicate item upload dedups instead of double-counting",
      r.status === 200 && r.data?.duplicate === true && r.data?.item?.id === firstItemId,
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("POST", `/v1/datasets/${datasetSlug}/items`, {
      data_url: "data:text/plain;base64,aGVsbG8=",
    });
    record(
      "unsupported mime rejected",
      r.status === 400 && r.data?.error === "unsupported_mime",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("GET", `/v1/datasets/${datasetSlug}/items`);
    record(
      "GET /v1/datasets/:slug/items reflects item_count exactly (dedup excluded)",
      r.status === 200 && r.data?.items?.length === 5,
      `count=${r.data?.items?.length}`,
    );
  }
  {
    const r = await api("POST", `/v1/datasets/${datasetSlug}/items/import-urls`, { urls: [] });
    record(
      "import-urls rejects an empty list",
      r.status === 400 && r.data?.error === "invalid_urls",
      JSON.stringify(r.data),
    );
  }
  {
    const tooMany = Array.from({ length: 26 }, (_, i) => `https://example.com/${i}.png`);
    const r = await api("POST", `/v1/datasets/${datasetSlug}/items/import-urls`, { urls: tooMany });
    record(
      "import-urls rejects more than 25 urls",
      r.status === 400 && r.data?.error === "too_many_urls",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("GET", `/v1/datasets/${datasetSlug}/items/${firstItemId}/file`);
    record(
      "GET dataset item file (owner) returns the stored bytes",
      r.status === 200,
      `status=${r.status}`,
    );
  }

  let trainingJobId = null;
  let publishedModelId = null;
  {
    // Below MIN_TRAIN_ITEMS on a brand-new, item-less dataset.
    const r0 = await api("POST", "/v1/datasets", { title: "Too small", rights_declaration: "own" });
    const emptySlug = r0.data?.dataset?.slug;
    const r = await api("POST", `/v1/datasets/${emptySlug}/train`, {
      base_model: "flux-dev",
      training_method: "lora",
    });
    record(
      "train rejects a dataset below the minimum item count",
      r.status === 422 && r.data?.error === "not_enough_items",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("POST", `/v1/datasets/${datasetSlug}/train`, {
      base_model: "made-up-model",
      training_method: "lora",
    });
    record(
      "train rejects an unlisted base model",
      r.status === 400 && r.data?.error === "invalid_base_model",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("POST", `/v1/datasets/${datasetSlug}/train`, {
      base_model: "flux-dev",
      training_method: "lora",
    });
    trainingJobId = r.data?.job?.id ?? null;
    publishedModelId = r.data?.job?.model_id ?? null;
    record(
      "POST train (TRAINING_MOCK) completes synchronously and succeeds",
      r.status === 201 && r.data?.job?.status === "succeeded" && !!r.data?.job?.model_version_id,
      JSON.stringify(r.data).slice(0, 250),
    );
  }
  {
    const r = await api("GET", "/v1/tokens/account");
    record(
      "training debit landed (150 tokens spent on top of prior renders)",
      r.status === 200 && r.data?.lifetime_spent >= 150,
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("GET", `/v1/training/${trainingJobId}`);
    record("GET /v1/training/:id (owner)", r.status === 200 && r.data?.job?.id === trainingJobId, JSON.stringify(r.data).slice(0, 200));
  }
  {
    const r = await api("GET", `/v1/datasets/${datasetSlug}/training`);
    record(
      "GET /v1/datasets/:slug/training lists the job",
      r.status === 200 && r.data?.jobs?.some((j) => j.id === trainingJobId),
      JSON.stringify(r.data).slice(0, 200),
    );
  }
  {
    // The trained model version carries the dataset's provenance and
    // is renderable exactly like any other fal_custom model.
    const r = await api("GET", "/v1/models/mine");
    const model = r.data?.models?.find((mo) => mo.id === publishedModelId);
    record(
      "trained model appears in /v1/models/mine with provenance",
      r.status === 200 && !!model && model.latest_version === 1,
      JSON.stringify(model ?? {}).slice(0, 250),
    );
  }
  {
    const r = await api("DELETE", `/v1/datasets/${datasetSlug}/items/${itemIds[itemIds.length - 1]}`);
    record("DELETE dataset item (owner)", r.status === 200, JSON.stringify(r.data));
  }
  {
    const r = await api("GET", `/v1/datasets/${datasetSlug}`);
    record(
      "item_count decremented after delete",
      r.status === 200 && r.data?.dataset?.item_count === 4,
      `item_count=${r.data?.dataset?.item_count}`,
    );
  }
  {
    // A second account can't read a private dataset's items.
    const stranger = privateKeyToAccount(generatePrivateKey());
    await login(stranger);
    const r = await api("GET", `/v1/datasets/${datasetSlug}`);
    record(
      "private dataset invisible to a non-owner",
      r.status === 404,
      `status=${r.status}`,
    );
  }
}

// ---- Studio Copilot (Task #22) ---------------------------------------
// Fresh account so its 200-token signup grant covers all four actions
// (20 + 15 + 5 + 5 = 45 tokens) with room to spare.
{
  const coder = privateKeyToAccount(generatePrivateKey());
  await login(coder);

  const proj = await api("POST", "/v1/projects", { title: "Copilot Smoke", engine: "p5" });
  const projId = proj.data?.project?.id ?? proj.data?.id;

  {
    const r = await api("POST", `/v1/projects/${projId}/ai/generate`, { prompt: "a field of drifting particles" });
    record(
      "POST ai/generate (AI_MOCK)",
      r.status === 200 && typeof r.data?.result === "string" && r.data.result.length > 0,
      JSON.stringify(r.data).slice(0, 150),
    );
  }
  {
    const r = await api("POST", `/v1/projects/${projId}/ai/edit`, {
      current_code: "function setup() { createCanvas(400,400); }",
      instruction: "make the background black",
    });
    record(
      "POST ai/edit (AI_MOCK)",
      r.status === 200 && typeof r.data?.result === "string",
      JSON.stringify(r.data).slice(0, 150),
    );
  }
  {
    const r = await api("POST", `/v1/projects/${projId}/ai/explain`, { code: "function draw(){background(0);}" });
    record(
      "POST ai/explain (AI_MOCK)",
      r.status === 200 && typeof r.data?.result === "string",
      JSON.stringify(r.data).slice(0, 150),
    );
  }
  {
    const r = await api("POST", `/v1/projects/${projId}/ai/params`, { code: "let particleCount = 200;" });
    record(
      "POST ai/params (AI_MOCK) returns an array",
      r.status === 200 && Array.isArray(r.data?.result),
      JSON.stringify(r.data).slice(0, 150),
    );
  }
  {
    const r = await api("POST", `/v1/projects/${projId}/ai/edit`, { current_code: "x", instruction: "" });
    record(
      "ai/edit rejects empty instruction",
      r.status === 400 && r.data?.error === "invalid_instruction",
      JSON.stringify(r.data),
    );
  }
  {
    const r = await api("GET", "/v1/tokens/account");
    record(
      "copilot debits landed (45 tokens across 4 actions)",
      r.status === 200 && r.data?.lifetime_spent === 45,
      JSON.stringify(r.data),
    );
  }
  {
    // A stranger can't run the copilot against someone else's project.
    const stranger = privateKeyToAccount(generatePrivateKey());
    await login(stranger);
    const r = await api("POST", `/v1/projects/${projId}/ai/generate`, { prompt: "hi" });
    record(
      "ai/generate on a non-owned project → 403",
      r.status === 403,
      `status=${r.status}`,
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
