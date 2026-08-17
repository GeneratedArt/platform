import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { requireAuth, type AuthVariables } from "./auth/middleware";
import { nonceHandler, verifyHandler } from "./auth/siwe";
import { meHandler, logoutHandler, patchMeHandler } from "./auth/me";
import {
  createProject,
  getProject,
  patchProject,
  archiveProject,
  listMyProjects,
  listProjectsForHandle,
} from "./projects/handlers";
import {
  prepareMint,
  confirmDeploy,
  confirmMint,
  mintConfigHandler,
  mintStateHandler,
} from "./projects/mint";
import {
  freezeProject,
  listFrozen,
  activateFrozen,
  retryPinFrozen,
} from "./projects/freeze";
import { runFrozenAudit } from "./jobs/frozenAudit";
import {
  getProjectFileHandler,
  commitProjectFileHandler,
  uploadCaptureHandler,
  getCaptureHandler,
} from "./projects/studio";
import {
  getUserByHandleHandler,
  followHandler,
  unfollowHandler,
  listFollowersHandler,
  listFollowingHandler,
} from "./users/handlers";
import {
  listBriefsHandler,
  getBriefHandler,
  createBriefHandler,
} from "./briefs/handlers";
import { searchHandler } from "./search/handlers";
import { exploreHandler } from "./explore/handlers";
import { projectOgHandler, projectOgDataHandler } from "./og/handlers";
import { pruneOldViewEvents } from "./db/events";
import {
  feedHandler,
  notificationsHandler,
  markNotificationsReadHandler,
} from "./feed/handlers";
import {
  projectTraitsHandler,
  projectMintsHandler,
  tokenDetailHandler,
} from "./projects/traits";
import {
  listGalleriesHandler,
  getGalleryHandler,
  createGalleryHandler,
  patchGalleryHandler,
  galleryProjectsHandler,
  uploadGalleryCoverHandler,
  projectGalleriesHandler,
} from "./galleries/handlers";
import {
  tokenAccountHandler,
  tokenLedgerHandler,
  listPacksHandler,
  confirmPurchaseHandler,
} from "./tokens/handlers";
import {
  createModelHandler,
  patchModelHandler,
  listModelsHandler,
  myModelsHandler,
  getModelHandler,
  publishVersionHandler,
  renderHandler,
  myJobsHandler,
  getJobHandler,
} from "./render/handlers";
import { accessMiddleware } from "./middleware/access";
import { logError } from "./lib/log";
import { captureException } from "./lib/sentry";
import { runUptimeProbe } from "./lib/uptime";
import { pruneOldMetrics } from "./lib/metrics";
import { requireAdmin } from "./auth/admin";
import {
  statsHandler,
  throwHandler,
  clientErrorHandler,
} from "./internal/stats";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// access log + request_id must run first so even preflight / 4xx
// carry x-request-id and a single access log line per request.
app.use("*", accessMiddleware);

app.use("*", async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  })(c, next);
});

app.get("/health", (c) =>
  c.json({ ok: true, service: "generatedart-api", ts: Date.now() }),
);

const v1 = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
v1.post("/auth/siwe/nonce", nonceHandler);
v1.post("/auth/siwe/verify", verifyHandler);
v1.post("/auth/logout", logoutHandler);
v1.get("/me", requireAuth, meHandler);
v1.patch("/me", requireAuth, patchMeHandler);

v1.post("/projects", requireAuth, createProject);
v1.get("/projects/mine", requireAuth, listMyProjects);
v1.get("/projects/:id{[0-9]+}", getProject);
v1.patch("/projects/:id{[0-9]+}", requireAuth, patchProject);
v1.post("/projects/:id{[0-9]+}/archive", requireAuth, archiveProject);
v1.get("/projects/:id{[0-9]+}/file", requireAuth, getProjectFileHandler);
v1.post("/projects/:id{[0-9]+}/commit", requireAuth, commitProjectFileHandler);
v1.post("/projects/:id{[0-9]+}/captures", requireAuth, uploadCaptureHandler);
v1.get("/captures/:rest{.+}", getCaptureHandler);

// Mint flow (Task #6). `prepare` is public for the `mint` phase
// (collectors don't need a SIWE session) and gates owner-only phases
// (deploy / lock_cid) inside the handler. confirm-deploy is owner-only;
// confirm-mint is public + verified against an on-chain receipt.
v1.get("/mint/config", mintConfigHandler);
v1.get("/projects/:id{[0-9]+}/mint/state", mintStateHandler);
v1.post("/projects/:id{[0-9]+}/mint/prepare", prepareMint);
v1.post("/projects/:id{[0-9]+}/mint/confirm-deploy", requireAuth, confirmDeploy);
v1.post("/projects/:id{[0-9]+}/mint/confirm-mint", confirmMint);

// Task #18: traits + per-token detail. All public; the mint row + its
// trait fan-out are written by `confirmMint`.
v1.get("/projects/:id{[0-9]+}/traits", projectTraitsHandler);
v1.get("/projects/:id{[0-9]+}/mints", projectMintsHandler);
v1.get("/projects/:id{[0-9]+}/mints/:tokenId{[0-9]+}", tokenDetailHandler);
// Task #19: galleries reverse lookup powering the "Curated by"
// badge on /p/?id=N.
v1.get("/projects/:id{[0-9]+}/galleries", projectGalleriesHandler);

// Task #19: galleries & curator surface. Slugs match the Jekyll
// route shape `/galleries/{slug}/`. Cover upload is its own
// endpoint (separate from project captures) so we can independently
// rate-limit + gate on `users.is_curator`. The cover-upload route
// must precede the `:slug` route so Hono doesn't try to match the
// literal "cover" as a slug.
v1.get("/galleries", listGalleriesHandler);
v1.post("/galleries", requireAuth, createGalleryHandler);
v1.post("/galleries/cover", requireAuth, uploadGalleryCoverHandler);
v1.get("/galleries/:slug{[a-z0-9-]+}", getGalleryHandler);
v1.patch("/galleries/:slug{[a-z0-9-]+}", requireAuth, patchGalleryHandler);
v1.post(
  "/galleries/:slug{[a-z0-9-]+}/projects",
  requireAuth,
  galleryProjectsHandler,
);

// Task #15: frozen artifact + provenance pipeline. POST /freeze and
// activate are owner-only; GET /frozen is public (the bundle CID and
// hash will be on-chain anyway).
v1.post("/projects/:id{[0-9]+}/freeze", requireAuth, freezeProject);
v1.get("/projects/:id{[0-9]+}/frozen", listFrozen);
v1.post(
  "/projects/:id{[0-9]+}/frozen/:fid{[0-9]+}/activate",
  requireAuth,
  activateFrozen,
);
v1.post(
  "/projects/:id{[0-9]+}/frozen/:fid{[0-9]+}/retry-pin",
  requireAuth,
  retryPinFrozen,
);

// User profile + social graph
v1.get("/users/:handle", getUserByHandleHandler);
v1.get("/users/:handle/projects", listProjectsForHandle);
v1.get("/users/:handle/followers", listFollowersHandler);
v1.get("/users/:handle/following", listFollowingHandler);
v1.post("/users/:handle/follow", requireAuth, followHandler);
v1.delete("/users/:handle/follow", requireAuth, unfollowHandler);

// Briefs board (Task #7). Listing + detail are public; posting requires auth
// and is rate-limited to 5/address/day inside the handler.
v1.get("/briefs", listBriefsHandler);
v1.get("/briefs/:id{[0-9]+}", getBriefHandler);
v1.post("/briefs", requireAuth, createBriefHandler);

// Discovery & search surfaces. All public; no auth.
v1.get("/explore", exploreHandler);
v1.get("/search", searchHandler);
// Server-rendered OG landing — used by social crawlers when sharing
// /v1/og/projects/:id; humans get an instant meta-refresh to /p/?id=N.
v1.get("/og/projects/:id{[0-9]+}", projectOgHandler);
// JSON variant consumed by the /p/ Pages Function so the static
// project page itself carries project-specific OG meta.
v1.get("/og/projects/:id{[0-9]+}/data", projectOgDataHandler);

// Activity feed + in-app notifications. All three are personal — the
// handlers set Cache-Control: private,no-store so the edge cache
// never mixes one viewer's feed with another's.
v1.get("/feed", requireAuth, feedHandler);
v1.get("/notifications", requireAuth, notificationsHandler);
v1.post("/notifications/read", requireAuth, markNotificationsReadHandler);

// Render-token service. Balances/ledger/purchases are all personal or
// public catalogue reads — no admin surface needed yet. Route order
// matters: the literal "mine" and "packs"/"purchase" segments must
// precede the `:slug`/`:id` patterns below so Hono doesn't swallow them
// as a slug/id (same reasoning as the galleries "cover" route above).
v1.get("/tokens/account", requireAuth, tokenAccountHandler);
v1.get("/tokens/ledger", requireAuth, tokenLedgerHandler);
v1.get("/tokens/packs", listPacksHandler);
v1.post("/tokens/purchase/confirm", requireAuth, confirmPurchaseHandler);

v1.get("/models", listModelsHandler);
v1.get("/models/mine", requireAuth, myModelsHandler);
v1.post("/models", requireAuth, createModelHandler);
v1.get("/models/:slug{[a-z0-9-]+}", getModelHandler);
v1.patch("/models/:slug{[a-z0-9-]+}", requireAuth, patchModelHandler);
v1.post("/models/:slug{[a-z0-9-]+}/versions", requireAuth, publishVersionHandler);
v1.post("/models/:slug{[a-z0-9-]+}/render", requireAuth, renderHandler);

v1.get("/jobs", requireAuth, myJobsHandler);
v1.get("/jobs/:id{[0-9]+}", requireAuth, getJobHandler);

// Admin-only observability surface. requireAuth runs first so
// requireAdmin can read the session. _throw is a forced 500 used
// to verify the request_id round-trips end to end.
v1.get("/internal/stats", requireAuth, requireAdmin, statsHandler);
v1.get("/internal/_throw", requireAuth, requireAdmin, throwHandler);
v1.post("/internal/client-error", clientErrorHandler);

app.route("/v1", v1);

app.notFound((c) =>
  c.json({ error: "not_found", request_id: c.get("requestId") }, 404),
);
app.onError((err, c) => {
  const requestId = c.get("requestId");
  const route = c.req.routePath || c.req.path;
  logError(requestId, "unhandled_exception", err, { route });
  // Tie the Sentry beacon to the request lifecycle via waitUntil so
  // the runtime keeps the worker alive until the POST completes —
  // a plain `void` would let CF cancel the in-flight fetch as soon
  // as the 500 response is sent.
  const sentryPromise = captureException(c.env, err, {
    request_id: requestId,
    route,
    status: 500,
    user_id: c.get("user")?.uid ?? null,
  });
  try {
    c.executionCtx.waitUntil(sentryPromise);
  } catch {
    // executionCtx may not exist in some test contexts; fall back
    // to a fire-and-forget which is at least no worse than before.
    void sentryPromise;
  }
  return c.json({ error: "internal_error", request_id: requestId }, 500);
});

// Task #15: Cloudflare scheduled handler. The cron trigger in
// wrangler.toml fires this nightly to re-check pin health and mark
// drifted versions for re-pin in a follow-up job. Defined alongside
// `fetch` so wrangler can route both into the same Worker.
export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // "* * * * *" → uptime probe;  "0 4 * * *" → daily audit + prune.
    if (event.cron === "* * * * *") {
      ctx.waitUntil(
        runUptimeProbe(env).catch((e) =>
          console.error("uptime_probe_failed", (e as Error).message),
        ),
      );
      return;
    }
    ctx.waitUntil(runFrozenAudit(env));
    ctx.waitUntil(pruneOldViewEvents(env.DB).catch((e) => console.error("prune_views_failed", e)));
    ctx.waitUntil(
      pruneOldMetrics(env.DB).catch((e) =>
        console.error("prune_metrics_failed", (e as Error).message),
      ),
    );
  },
};
