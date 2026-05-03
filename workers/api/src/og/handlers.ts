// OG-card landing for shared project links.
//
// Why this exists: /p/?id=N is fully client-rendered (Jekyll can't
// generate one static page per integer id without a build-time
// integration with D1). Social crawlers (Twitter, Farcaster, Discord,
// Slack) don't run JS, so they'd see the generic site OG image on
// every share. This handler returns server-rendered HTML with
// project-specific OG meta + a canonical link to /p/?id=N + a
// `<meta http-equiv="refresh">` so a human who lands here is
// immediately redirected to the real page.
//
// The OG image points at the project's most recent capture (R2
// `captures/{id}/…png`) resized to 1200×630 via the existing
// captures resize pipeline (?w=1200). When no capture exists we
// fall back to the site default OG image so links always render
// SOMETHING rather than a broken preview.

import type { Context } from "hono";
import type { Env } from "../types";
import { getProjectById } from "../db/projects";
import { getProjectOwner } from "../db/projects";

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
  // Prefer the first allowed origin (production canonical). Falls
  // back to a sensible default for local dev.
  const first = env.ALLOWED_ORIGINS?.split(",")[0]?.trim();
  return first || "https://generatedart.com";
}

async function findLatestCaptureKey(
  env: Env,
  projectId: number,
): Promise<string | null> {
  if (!env.CAPTURES) return null;
  // Captures are keyed `captures/{id}/{ts}-{seed}.png`. R2's `list`
  // returns keys in ascending order, so we scan and pick the largest
  // timestamp prefix manually. We cap at 100 to bound work.
  const list = await env.CAPTURES.list({
    prefix: `captures/${projectId}/`,
    limit: 100,
  });
  if (!list.objects || list.objects.length === 0) return null;
  let latest = list.objects[0];
  for (const o of list.objects) {
    if (o.uploaded > latest.uploaded) latest = o;
  }
  return latest.key;
}

/**
 * GET /v1/og/projects/:id
 *
 * Returns text/html with project-specific OG tags + meta-refresh to
 * /p/?id=N. Crawlers parse the OG; humans get redirected.
 */
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

  let ogImage: string | null = project.cover_url ?? null;
  if (!ogImage) {
    const captureKey = await findLatestCaptureKey(c.env, project.id);
    if (captureKey) {
      // ?w=1200 lands on the captures handler which (when Cloudflare
      // Image Resizing is provisioned) resizes; today it's a passthrough
      // so the URL is forward-compatible without breaking now.
      const base = c.env.CAPTURES_PUBLIC_BASE || origin;
      ogImage = `${base.replace(/\/$/, "")}/v1/captures/${captureKey}?w=1200`;
    }
  }
  if (!ogImage) ogImage = `${origin}${SITE_DEFAULT_OG}`;

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
