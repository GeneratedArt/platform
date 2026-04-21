/**
 * GeneratedArt renderer.
 * URL: https://renderer.generatedart.com/render?cid=<bundleCID>&hash=<tokenHash>&res=<w>x<h>
 *
 * Fetches `ipfs://<cid>/index.html` via Cloudflare's IPFS gateway, injects a
 * <script> at the top of <head> exposing window.$ga = { hash, rand, features, preview }.
 * Serves with a strict CSP so untrusted artist code is sandboxed.
 */
export interface Env {
  ASSETS: R2Bucket;
  ENVIRONMENT: string;
  IPFS_GATEWAY: string;
}

const SDK_TEMPLATE = (hash: string) => `
<script>
(function () {
  // Mulberry32 seeded from first 32 bits of the hash.
  function seedFromHash(h) {
    var hex = h.replace(/^0x/, '').slice(0, 8) || '00000000';
    return parseInt(hex, 16) >>> 0;
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
  return [
    `default-src 'self' ${o}`,
    `script-src 'unsafe-inline' 'unsafe-eval' ${o}`,
    `style-src 'unsafe-inline' 'self' ${o}`,
    `img-src 'self' data: blob: ${o}`,
    `media-src 'self' data: blob: ${o}`,
    `connect-src 'self' ${o}`,
    `font-src 'self' data: ${o}`,
    `frame-ancestors *`,
  ].join("; ");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ service: "renderer", env: env.ENVIRONMENT }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname !== "/render") return new Response("not found", { status: 404 });

    const cid = url.searchParams.get("cid");
    const hash = url.searchParams.get("hash");
    if (!cid || !hash) return new Response("missing cid/hash", { status: 400 });

    const upstream = `${env.IPFS_GATEWAY.replace(/\/$/, "")}/ipfs/${cid}/index.html`;
    const res = await fetch(upstream, { cf: { cacheTtl: 31536000, cacheEverything: true } });
    if (!res.ok) return new Response(`upstream ${res.status}`, { status: 502 });

    let html = await res.text();
    const inject = SDK_TEMPLATE(hash);
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
    } else {
      html = inject + html;
    }

    // NOTE: do NOT set X-Frame-Options — embedding is intentional from
    // app.generatedart.com / collector dashboards. Cross-origin embedding is
    // controlled exclusively by the CSP `frame-ancestors` directive above.
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp(env.IPFS_GATEWAY),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
};
