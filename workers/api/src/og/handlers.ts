// Server-rendered OG card for shared project links. Crawlers parse the
// meta tags; humans get redirected to /p/?id=N via meta-refresh + JS.

import type { Context } from "hono";
import type { Env } from "../types";
import { getProjectById, getProjectOwner } from "../db/projects";

const SITE_DEFAULT_OG = "/assets/images/og-default.png";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function siteOrigin(env: Env): string {
  const first = env.ALLOWED_ORIGINS?.split(",")[0]?.trim();
  return first || "https://generatedart.com";
}

function captureUrl(env: Env, key: string, w: number): string {
  const base = (env.CAPTURES_PUBLIC_BASE || siteOrigin(env)).replace(/\/$/, "");
  return `${base}/v1/captures/${key}?w=${w}`;
}

export async function projectOgHandler(c: Context<{ Bindings: Env }>) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return c.text("invalid id", 400);

  const project = await getProjectById(c.env.DB, id);
  if (!project || (project.status !== "published" && project.status !== "minted")) {
    return c.text("not found", 404);
  }
  const owner = await getProjectOwner(c.env.DB, project.owner_id);
  const origin = siteOrigin(c.env);
  const canonical = `${origin}/p/?id=${id}`;

  let ogImage: string;
  if (project.last_capture_key) {
    ogImage = captureUrl(c.env, project.last_capture_key, 1200);
  } else if (project.cover_url) {
    ogImage = project.cover_url;
  } else {
    ogImage = `${origin}${SITE_DEFAULT_OG}`;
  }

  const title = project.title;
  const description =
    project.description?.replace(/\s+/g, " ").trim().slice(0, 200) ||
    `A generative-art project on GeneratedArt by @${owner?.handle ?? "artist"}.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — GeneratedArt</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />

<meta property="og:type" content="article" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:site_name" content="GeneratedArt" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:url" content="${escapeHtml(canonical)}" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(ogImage)}" />

<meta http-equiv="refresh" content="0; url=${escapeHtml(canonical)}" />
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(canonical)}">${escapeHtml(title)}</a>…</p>
<script>window.location.replace(${JSON.stringify(canonical)});</script>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
