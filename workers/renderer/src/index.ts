/**
 * GeneratedArt renderer.
 * URL: https://renderer.generatedart.com/render?cid=<bundleCID>&hash=<tokenHash>&res=<w>x<h>
 *
 * Fetches `ipfs://<cid>/index.html` via Cloudflare's IPFS gateway, injects a
 * <script> at the top of <head> exposing window.$ga = { hash, rand, features,
 * preview }. Serves with a strict CSP so untrusted artist code is sandboxed.
 *
 * Embedding policy: every consumer (app.generatedart.com, app/embed/<id>, the
 * capture worker) loads the renderer in
 *   <iframe sandbox="allow-scripts allow-pointer-lock" src="https://renderer.generatedart.com/render?...">
 * The sandbox attribute strips the iframe to a fresh, opaque origin, so
 * `X-Frame-Options: SAMEORIGIN` is a safe extra layer that prevents naked
 * cross-origin embedding without the sandbox.
 */
export interface Env {
  ASSETS: R2Bucket;
  ENVIRONMENT: string;
  IPFS_GATEWAY: string;
}

const SDK_TEMPLATE = (hash: string, w: number, h: number) => `
<script>
(function () {
  function seedFromHash(h) {
    var hex = h.replace(/^0x/, '').slice(0, 8) || '00000000';
    return parseInt(hex.padStart(8, '0'), 16) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = mulberry32(seedFromHash(${JSON.stringify(hash)}));
  window.$ga = {
    hash: ${JSON.stringify(hash)},
    width: ${w},
    height: ${h},
    rand: rand,
    features: {},
    preview: function () {
      try { window.parent.postMessage({ type: 'ga:preview' }, '*'); } catch (e) {}
    }
  };
})();
</script>`.trim();

function csp(ipfsGateway: string) {
  const o = new URL(ipfsGateway).origin;
  // Spec §9: default-src 'self' <ipfs>; script-src 'unsafe-inline' <ipfs>.
  // Inline scripts are the injection vector ($ga setup) so 'unsafe-inline' is
  // mandatory; the sandboxed iframe contains the blast radius. We add img/
  // media/style/font/connect for the sake of legitimate bundle assets, all
  // restricted to 'self' and the IPFS gateway origin.
  return [
    `default-src 'self' ${o}`,
    `script-src 'self' 'unsafe-inline' ${o}`,
    `style-src 'self' 'unsafe-inline' ${o}`,
    `img-src 'self' data: blob: ${o}`,
    `media-src 'self' data: blob: ${o}`,
    `font-src 'self' data: ${o}`,
    `connect-src 'self' ${o}`,
    `object-src 'none'`,
    `base-uri 'none'`,
  ].join("; ");
}

function parseRes(raw: string | null): { w: number; h: number } {
  if (!raw) return { w: 1024, h: 1024 };
  const m = raw.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!m) return { w: 1024, h: 1024 };
  // Cap at 4096 to stop someone asking the renderer to allocate a 50000² canvas.
  const clamp = (n: number) => Math.max(64, Math.min(4096, n));
  return { w: clamp(parseInt(m[1], 10)), h: clamp(parseInt(m[2], 10)) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ service: "renderer", env: env.ENVIRONMENT }),
        { headers: { "content-type": "application/json" } }
      );
    }
    if (url.pathname !== "/render") {
      return new Response("not found", { status: 404 });
    }

    const cid = url.searchParams.get("cid");
    const hash = url.searchParams.get("hash");
    if (!cid || !hash) return new Response("missing cid/hash", { status: 400 });
    if (!/^[A-Za-z0-9]{10,120}$/.test(cid)) {
      return new Response("invalid cid", { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{2,66}$/.test(hash)) {
      return new Response("invalid hash", { status: 400 });
    }
    const { w, h } = parseRes(url.searchParams.get("res"));

    const upstream = `${env.IPFS_GATEWAY.replace(/\/$/, "")}/ipfs/${cid}/index.html`;
    const res = await fetch(upstream, {
      cf: { cacheTtl: 31536000, cacheEverything: true },
    });
    if (!res.ok) return new Response(`upstream ${res.status}`, { status: 502 });

    let html = await res.text();
    const inject = SDK_TEMPLATE(hash, w, h);
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
    } else {
      html = inject + html;
    }

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp(env.IPFS_GATEWAY),
        // Spec §9: `X-Frame-Options: SAMEORIGIN`. Modern browsers prefer the
        // CSP `frame-ancestors` directive when both are present; we omit the
        // CSP one here so XFO governs naked embedding while every legitimate
        // consumer loads us inside `<iframe sandbox=...>` (opaque origin).
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "no-referrer",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
};
