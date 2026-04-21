/**
 * GeneratedArt API Worker
 * Hono on Cloudflare Workers. D1 + KV + R2 + Queues.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env, Variables } from "./lib/env";
import { loadSession } from "./lib/middleware";
import { rateLimit } from "./lib/ratelimit";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { artistRoutes } from "./routes/artists";
import { projectRoutes } from "./routes/projects";
import { editionRoutes } from "./routes/editions";
import { ownerRoutes } from "./routes/owners";
import { galleryRoutes } from "./routes/galleries";

export type { Env };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = [
        c.env.SITE_ORIGIN,
        "https://generatedart.com",
        "https://app.generatedart.com",
        "http://localhost:4000",
        "http://localhost:4321",
        "http://localhost:5000",
      ];
      return origin && allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type"],
  })
);

// Session loader runs before rate limiter so per-user limits apply.
app.use("*", loadSession);
app.use("*", rateLimit);

app.get("/", (c) =>
  c.json({
    service: "generatedart-api",
    version: "0.2.0",
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

app.route("/auth", authRoutes);
app.route("/me", meRoutes);
app.route("/artists", artistRoutes);
app.route("/projects", projectRoutes);
app.route("/editions", editionRoutes);
app.route("/owners", ownerRoutes);
app.route("/galleries", galleryRoutes);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("api_error", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
