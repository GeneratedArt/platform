// Cloudflare Pages Function. Wraps the static /p/ Jekyll page so that
// when a visitor (or social crawler) hits /p/?id=N we rewrite the
// page <head> with project-specific OG/Twitter tags backed by the
// active frozen capture. Without this, all shared project links
// would render the generic site OG card. The static page still
// hydrates the body via /v1/projects/:id on the client.

interface OgData {
  id: number;
  title: string;
  description: string;
  canonical: string;
  og_image: string;
  owner_handle: string | null;
}

interface Env {
  API_ORIGIN?: string;
}

const DEFAULT_API_ORIGIN = "https://api.generatedart.com";

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

class OgRewriter {
  constructor(private og: OgData) {}
  element(el: Element) {
    const o = this.og;
    const tags = [
      `<title>${escapeAttr(o.title)} — GeneratedArt</title>`,
      `<meta name="description" content="${escapeAttr(o.description)}" />`,
      `<link rel="canonical" href="${escapeAttr(o.canonical)}" />`,
      `<meta property="og:type" content="article" />`,
      `<meta property="og:url" content="${escapeAttr(o.canonical)}" />`,
      `<meta property="og:title" content="${escapeAttr(o.title)}" />`,
      `<meta property="og:description" content="${escapeAttr(o.description)}" />`,
      `<meta property="og:image" content="${escapeAttr(o.og_image)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:site_name" content="GeneratedArt" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeAttr(o.title)}" />`,
      `<meta name="twitter:description" content="${escapeAttr(o.description)}" />`,
      `<meta name="twitter:image" content="${escapeAttr(o.og_image)}" />`,
    ].join("\n");
    el.append(tags, { html: true });
  }
}

class StripDuplicateMeta {
  element(el: Element) {
    const prop = el.getAttribute("property") || el.getAttribute("name") || "";
    const drop = new Set([
      "og:type", "og:url", "og:title", "og:description", "og:image",
      "og:image:width", "og:image:height", "og:site_name",
      "twitter:card", "twitter:title", "twitter:description", "twitter:image",
      "description",
    ]);
    if (drop.has(prop)) el.remove();
  }
}

class StripTitle {
  element(el: Element) { el.remove(); }
}

class StripCanonical {
  element(el: Element) {
    if (el.getAttribute("rel") === "canonical") el.remove();
  }
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const idRaw = url.searchParams.get("id");
  const id = idRaw && /^\d+$/.test(idRaw) ? parseInt(idRaw, 10) : null;

  const upstream = await ctx.next();
  if (!id) return upstream;

  const apiOrigin = (ctx.env.API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, "");
  let og: OgData | null = null;
  try {
    const res = await fetch(`${apiOrigin}/v1/og/projects/${id}/data`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (res.ok) og = (await res.json()) as OgData;
  } catch {
    // Fall through to the unmodified page.
  }
  if (!og) return upstream;

  const rewriter = new HTMLRewriter()
    .on('meta[property^="og:"]', new StripDuplicateMeta())
    .on('meta[name^="twitter:"]', new StripDuplicateMeta())
    .on('meta[name="description"]', new StripDuplicateMeta())
    .on("title", new StripTitle())
    .on('link[rel="canonical"]', new StripCanonical())
    .on("head", new OgRewriter(og));

  const rewritten = rewriter.transform(upstream);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  return new Response(rewritten.body, {
    status: rewritten.status,
    headers,
  });
};
