import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = Record<string, never>;

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: [
      "https://generatedart.com",
      "https://www.generatedart.com",
      "http://localhost:5000",
    ],
    credentials: true,
  }),
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "generatedart-api", ts: Date.now() }),
);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
