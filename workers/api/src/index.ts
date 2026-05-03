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

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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

app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

// Task #15: Cloudflare scheduled handler. The cron trigger in
// wrangler.toml fires this nightly to re-check pin health and mark
// drifted versions for re-pin in a follow-up job. Defined alongside
// `fetch` so wrangler can route both into the same Worker.
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runFrozenAudit(env));
  },
};
