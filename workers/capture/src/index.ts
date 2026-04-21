/**
 * GeneratedArt capture worker.
 *
 * Consumes the RENDER_QUEUE. For each job:
 *   - opens https://renderer.generatedart.com/render?cid=...&hash=... in
 *     Cloudflare Browser Rendering at 2048×2048
 *   - waits for `ga:preview` postMessage (or a hard timeout)
 *   - screenshots PNG and writes to R2 at `captures/<contract>/<tokenId>.png`
 *     (or `previews/<slug>/<token_hash>.png` for ad-hoc preview jobs)
 *   - PATCHes editions.preview_r2_key for mint-triggered jobs
 *
 * Two job shapes are accepted:
 *   { type: 'mint', contract, token_id, cid, hash }
 *   { type: 'preview', slug, token_hash, repo, tag, r2_key }
 */
import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
  ASSETS: R2Bucket;
  DB: D1Database;
  BROWSER: BrowserWorker;
  RENDERER_BASE: string;
  IPFS_GATEWAY: string;
  ENVIRONMENT: string;
}

interface MintJob {
  type: "mint";
  contract: string;
  token_id: number;
  cid: string;
  hash: string;
}

interface PreviewJob {
  type: "preview";
  slug: string;
  token_hash: string;
  repo: string;
  tag: string | null;
  r2_key: string;
  cid?: string;
}

type Job = MintJob | PreviewJob;

const VIEWPORT = { width: 2048, height: 2048, deviceScaleFactor: 1 };
const MAX_WAIT_MS = 30_000;
const FRAMES_AFTER_PREVIEW = 4;

async function captureOne(env: Env, job: Job): Promise<{ key: string; bytes: number }> {
  const cid = job.type === "mint" ? job.cid : job.cid;
  const hash = job.type === "mint" ? job.hash : job.token_hash;
  if (!cid) throw new Error(`no cid for job ${JSON.stringify(job)}`);

  const url = `${env.RENDERER_BASE.replace(/\/$/, "")}/render?cid=${encodeURIComponent(
    cid
  )}&hash=${encodeURIComponent(hash)}&res=${VIEWPORT.width}x${VIEWPORT.height}`;

  const browser = await puppeteer.launch(env.BROWSER);
  let png: Uint8Array;
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Wait for the bundle to call $ga.preview() (which postMessages to parent).
    // We listen on the page's console-bridge equivalent: inject a script that
    // resolves a global promise when the message lands, then `evaluate` it.
    await page.evaluateOnNewDocument(() => {
      (self as any).__gaPreviewReady = new Promise<void>((resolve) => {
        self.addEventListener("message", (e: MessageEvent) => {
          if ((e.data as any)?.type === "ga:preview") resolve();
        });
        // Hard cap — we still capture even if the bundle never signals.
        setTimeout(resolve, 25_000);
      });
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: MAX_WAIT_MS });
    await page.evaluate(() => (self as any).__gaPreviewReady);
    // Settle a few RAFs after preview-ready before screenshotting.
    await page.evaluate(
      (n: number) =>
        new Promise<void>((resolve) => {
          let i = 0;
          const tick = () => (i++ >= n ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      FRAMES_AFTER_PREVIEW
    );

    png = (await page.screenshot({ type: "png", fullPage: false })) as Uint8Array;
  } finally {
    await browser.close();
  }

  const key =
    job.type === "mint"
      ? `captures/${job.contract.toLowerCase()}/${job.token_id}.png`
      : job.r2_key;
  await env.ASSETS.put(key, png, {
    httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: {
      hash,
      cid,
      job_type: job.type,
      captured_at: String(Date.now()),
    },
  });
  return { key, bytes: png.byteLength };
}

async function processMintJob(env: Env, job: MintJob, key: string) {
  const editionId = `${job.contract.toLowerCase()}:${job.token_id}`;
  await env.DB.prepare(
    `UPDATE editions SET preview_r2_key = ? WHERE id = ?`
  )
    .bind(key, editionId)
    .run();
}

export default {
  async queue(batch: MessageBatch<Job>, env: Env, _ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        const { key, bytes } = await captureOne(env, job);
        if (job.type === "mint") await processMintJob(env, job, key);
        console.log(`captured ${job.type} → r2://${key} (${bytes}B)`);
        msg.ack();
      } catch (err) {
        console.error(`capture failed`, job, (err as Error).message);
        // Let the queue retry per its policy. After max retries it lands in the DLQ.
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        service: "capture",
        env: env.ENVIRONMENT,
        renderer: env.RENDERER_BASE,
      });
    }
    return new Response("generatedart-capture", { status: 200 });
  },
};
