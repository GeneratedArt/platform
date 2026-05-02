import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { requireAuth, type AuthVariables } from "./auth/middleware";
import { nonceHandler, verifyHandler } from "./auth/siwe";
import { meHandler, logoutHandler } from "./auth/me";
import {
  createProject,
  getProject,
  patchProject,
  archiveProject,
  listMyProjects,
  listProjectsForHandle,
} from "./projects/handlers";
import {
  getProjectFileHandler,
  commitProjectFileHandler,
  uploadCaptureHandler,
  getCaptureHandler,
} from "./projects/studio";

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

v1.post("/projects", requireAuth, createProject);
v1.get("/projects/mine", requireAuth, listMyProjects);
v1.get("/projects/:id{[0-9]+}", getProject);
v1.patch("/projects/:id{[0-9]+}", requireAuth, patchProject);
v1.post("/projects/:id{[0-9]+}/archive", requireAuth, archiveProject);
v1.get("/projects/:id{[0-9]+}/file", requireAuth, getProjectFileHandler);
v1.post("/projects/:id{[0-9]+}/commit", requireAuth, commitProjectFileHandler);
v1.post("/projects/:id{[0-9]+}/captures", requireAuth, uploadCaptureHandler);
v1.get("/captures/:rest{.+}", getCaptureHandler);
v1.get("/users/:handle/projects", listProjectsForHandle);

app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
