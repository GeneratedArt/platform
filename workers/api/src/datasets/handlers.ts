import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { checkRateLimit } from "../lib/rateLimit";
import { uniqueDatasetSlug } from "../lib/slug";
import {
  isRightsDeclaration,
  isDatasetVisibility,
  isItemKind,
  insertDataset,
  getDatasetByOwnerAndSlug,
  updateDataset,
  listDatasetsByOwner,
  publicDataset,
  insertDatasetItem,
  listDatasetItems,
  getDatasetItem,
  deleteDatasetItem,
  publicDatasetItem,
  insertTrainingJob,
  getTrainingJobByIdempotencyKey,
  getTrainingJobById,
  listTrainingJobsByUser,
  listTrainingJobsByDataset,
  markTrainingSubmitted,
  publicTrainingJob,
  type DatasetRow,
} from "../db/datasets";
import { insertModel, uniqueModelSlug } from "../db/render";
import { applyLedgerEntry } from "../db/tokens";
import {
  isTrainableBaseModel,
  isTrainingMock,
  runMockTraining,
  trainingPriceTokens,
  completeJob,
  TRAINABLE_BASE_MODELS,
} from "../ai/training";

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

const TITLE_MAX = 120;
const DESC_MAX = 4000;
const CAPTION_MAX = 500;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

// Base64 inflates ~33%; these caps are on DECODED bytes, checked after
// atob. A JSON body carrying a 15MB video item is ~20MB on the wire —
// comfortably inside Workers' request body limits.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const MIN_TRAIN_ITEMS = 5; // a token floor — real LoRA training wants dozens+

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

interface CreateDatasetBody {
  title?: unknown;
  description?: unknown;
  rights_declaration?: unknown;
  visibility?: unknown;
}

/** POST /v1/datasets — create an (empty) dataset shell. */
export async function createDatasetHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `datasets:create:${session.uid}`,
    limit: 20,
    windowSeconds: 86400,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CreateDatasetBody;
  try {
    body = await c.req.json<CreateDatasetBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) {
    return badRequest(c, "invalid_title", { max: TITLE_MAX });
  }
  // Required, plain-language self-declaration — not a verification
  // step. See migrations/0020_dataset_library.sql.
  if (!isRightsDeclaration(body.rights_declaration)) {
    return badRequest(c, "invalid_rights_declaration", {
      allowed: ["own", "licensed", "public_domain"],
    });
  }
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string" || body.description.length > DESC_MAX) {
      return badRequest(c, "invalid_description", { max: DESC_MAX });
    }
    description = body.description.trim() || null;
  }
  const visibility = isDatasetVisibility(body.visibility) ? body.visibility : "private";

  const slug = await uniqueDatasetSlug(c.env.DB, session.uid, title);
  const dataset = await insertDataset(c.env.DB, {
    ownerId: session.uid,
    slug,
    title,
    description,
    rightsDeclaration: body.rights_declaration,
    visibility,
  });
  return c.json({ dataset: publicDataset(dataset) }, 201);
}

/** GET /v1/datasets/mine */
export async function myDatasetsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const rows = await listDatasetsByOwner(c.env.DB, session.uid);
  return c.json({ datasets: rows.map(publicDataset) });
}

async function loadOwnedDataset(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<DatasetRow | null> {
  const session = getAuthUser(c);
  const slug = c.req.param("slug") || "";
  const dataset = await getDatasetByOwnerAndSlug(c.env.DB, session.uid, slug);
  if (!dataset) return null;
  return dataset;
}

/**
 * GET /v1/datasets/:slug — owner-only. Datasets are private by
 * default and this Worker doesn't yet have a cross-owner slug lookup
 * (slugs are unique per-owner, not globally) — a future public
 * dataset-browsing surface needs its own indexed lookup; today only
 * the owner can address their dataset by slug.
 */
export async function getDatasetHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  return c.json({ dataset: publicDataset(dataset) });
}

interface PatchDatasetBody {
  title?: unknown;
  description?: unknown;
  rights_declaration?: unknown;
  visibility?: unknown;
}

/** PATCH /v1/datasets/:slug — owner-only edits. */
export async function patchDatasetHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);

  let body: PatchDatasetBody;
  try {
    body = await c.req.json<PatchDatasetBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const patch: Parameters<typeof updateDataset>[2] = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > TITLE_MAX) {
      return badRequest(c, "invalid_title", { max: TITLE_MAX });
    }
    patch.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && (typeof body.description !== "string" || body.description.length > DESC_MAX)) {
      return badRequest(c, "invalid_description", { max: DESC_MAX });
    }
    patch.description = body.description === null ? null : (body.description as string).trim() || null;
  }
  if (body.rights_declaration !== undefined) {
    if (!isRightsDeclaration(body.rights_declaration)) return badRequest(c, "invalid_rights_declaration");
    patch.rightsDeclaration = body.rights_declaration;
  }
  if (body.visibility !== undefined) {
    if (!isDatasetVisibility(body.visibility)) return badRequest(c, "invalid_visibility");
    patch.visibility = body.visibility;
  }
  const updated = await updateDataset(c.env.DB, dataset.id, patch);
  return c.json({ dataset: publicDataset(updated ?? dataset) });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/s;

function decodeGenericDataUrl(
  dataUrl: string,
): { mime: string; bytes: Uint8Array } | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: m[1], bytes };
  } catch {
    return null;
  }
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm"]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface UploadItemBody {
  data_url?: unknown;
  caption?: unknown;
}

/**
 * POST /v1/datasets/:slug/items
 *
 * Accepts one image or video as a base64 data URL, stores it in R2
 * under `datasets/{datasetId}/{contentHash}.{ext}`, and dedups on
 * exact content hash — a byte-identical re-upload returns the
 * existing item (200) rather than a new one (201).
 */
export async function uploadDatasetItemHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const session = getAuthUser(c);

  if (!c.env.CAPTURES) {
    return c.json({ error: "storage_unconfigured" }, 503);
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `datasets:upload:${session.uid}`,
    limit: 500,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: UploadItemBody;
  try {
    body = await c.req.json<UploadItemBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  if (typeof body.data_url !== "string") return badRequest(c, "invalid_data_url");
  const decoded = decodeGenericDataUrl(body.data_url);
  if (!decoded) return badRequest(c, "invalid_data_url", "expected data:<mime>;base64,…");

  let kind: "image" | "video";
  let ext: string;
  if (IMAGE_MIMES.has(decoded.mime)) {
    kind = "image";
    ext = decoded.mime.split("/")[1] === "jpeg" ? "jpg" : decoded.mime.split("/")[1];
    if (decoded.bytes.byteLength > MAX_IMAGE_BYTES) {
      return badRequest(c, "item_too_large", { max_bytes: MAX_IMAGE_BYTES });
    }
  } else if (VIDEO_MIMES.has(decoded.mime)) {
    kind = "video";
    ext = decoded.mime.split("/")[1];
    if (decoded.bytes.byteLength > MAX_VIDEO_BYTES) {
      return badRequest(c, "item_too_large", { max_bytes: MAX_VIDEO_BYTES });
    }
  } else {
    return badRequest(c, "unsupported_mime", {
      allowed: [...IMAGE_MIMES, ...VIDEO_MIMES],
    });
  }

  let caption: string | null = null;
  if (body.caption !== undefined && body.caption !== null) {
    if (typeof body.caption !== "string" || body.caption.length > CAPTION_MAX) {
      return badRequest(c, "invalid_caption", { max: CAPTION_MAX });
    }
    caption = body.caption.trim() || null;
  }

  const contentHash = await sha256Hex(decoded.bytes);
  const r2Key = `datasets/${dataset.id}/${contentHash}.${ext}`;

  const result = await insertDatasetItem(c.env.DB, {
    datasetId: dataset.id,
    r2Key,
    kind,
    caption,
    contentHash,
    byteSize: decoded.bytes.byteLength,
    width: null,
    height: null,
    durationSeconds: null,
    status: "ready",
    flagReason: null,
  });

  if (result.status === "duplicate") {
    return c.json({ item: publicDatasetItem(result.existing), duplicate: true }, 200);
  }

  // Written after the DB row succeeds, keyed by content hash — an R2
  // write retry (or a concurrent request that lost the DB race) is
  // idempotent because it overwrites the same bytes at the same key.
  await c.env.CAPTURES.put(r2Key, decoded.bytes, {
    httpMetadata: { contentType: decoded.mime },
    customMetadata: {
      dataset_id: String(dataset.id),
      owner_id: String(session.uid),
    },
  });

  return c.json({ item: publicDatasetItem(result.item) }, 201);
}

const IMPORT_URLS_MAX = 25;

interface ImportUrlsBody {
  urls?: unknown;
}

/**
 * POST /v1/datasets/:slug/items/import-urls
 *
 * Fetches each URL server-side and stores it exactly like a direct
 * upload. Per-item results are reported individually — a batch of 25
 * URLs where 3 fail to resolve returns 22 successes and 3 named
 * failures, never an all-or-nothing outcome.
 */
export async function importDatasetItemsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const session = getAuthUser(c);

  if (!c.env.CAPTURES) {
    return c.json({ error: "storage_unconfigured" }, 503);
  }

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `datasets:import:${session.uid}`,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: ImportUrlsBody;
  try {
    body = await c.req.json<ImportUrlsBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    return badRequest(c, "invalid_urls");
  }
  if (body.urls.length > IMPORT_URLS_MAX) {
    return badRequest(c, "too_many_urls", { max: IMPORT_URLS_MAX });
  }

  const results: { url: string; status: string; item_id?: number }[] = [];
  for (const raw of body.urls) {
    const url = typeof raw === "string" ? raw : "";
    if (!url || !/^https?:\/\//.test(url)) {
      results.push({ url: String(raw).slice(0, 200), status: "invalid_url" });
      continue;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        results.push({ url, status: `fetch_failed_${res.status}` });
        continue;
      }
      const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
      const buf = new Uint8Array(await res.arrayBuffer());
      let kind: "image" | "video";
      let ext: string;
      if (IMAGE_MIMES.has(mime)) {
        kind = "image";
        ext = mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1];
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          results.push({ url, status: "too_large" });
          continue;
        }
      } else if (VIDEO_MIMES.has(mime)) {
        kind = "video";
        ext = mime.split("/")[1];
        if (buf.byteLength > MAX_VIDEO_BYTES) {
          results.push({ url, status: "too_large" });
          continue;
        }
      } else {
        results.push({ url, status: "unsupported_mime" });
        continue;
      }
      const contentHash = await sha256Hex(buf);
      const r2Key = `datasets/${dataset.id}/${contentHash}.${ext}`;
      const inserted = await insertDatasetItem(c.env.DB, {
        datasetId: dataset.id,
        r2Key,
        kind,
        caption: null,
        contentHash,
        byteSize: buf.byteLength,
        width: null,
        height: null,
        durationSeconds: null,
        status: "ready",
        flagReason: null,
      });
      if (inserted.status === "duplicate") {
        results.push({ url, status: "duplicate", item_id: inserted.existing.id });
        continue;
      }
      await c.env.CAPTURES.put(r2Key, buf, {
        httpMetadata: { contentType: mime },
        customMetadata: { dataset_id: String(dataset.id), owner_id: String(session.uid) },
      });
      results.push({ url, status: "ok", item_id: inserted.item.id });
    } catch (e) {
      results.push({ url, status: "error" });
      console.error("import_url_failed", url, e);
    }
  }
  const okCount = results.filter((r) => r.status === "ok").length;
  return c.json({ results, imported: okCount, total: results.length }, 201);
}

const ITEM_LIST_DEFAULT = 40;
const ITEM_LIST_MAX = 100;

/** GET /v1/datasets/:slug/items?limit=&before= */
export async function listDatasetItemsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = ITEM_LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > ITEM_LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: ITEM_LIST_MAX });
    }
    limit = n;
  }
  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;
  if (beforeRaw) {
    const n = parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) return badRequest(c, "invalid_before");
    before = n;
  }
  const rows = await listDatasetItems(c.env.DB, dataset.id, limit, before);
  return c.json({
    items: rows.map(publicDatasetItem),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

/** DELETE /v1/datasets/:slug/items/:itemId — owner-only. */
export async function deleteDatasetItemHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const itemId = parseInt(c.req.param("itemId") || "", 10);
  if (!itemId || Number.isNaN(itemId)) return badRequest(c, "invalid_item_id");
  const item = await getDatasetItem(c.env.DB, itemId);
  if (!item || item.dataset_id !== dataset.id) return c.json({ error: "not_found" }, 404);

  const deleted = await deleteDatasetItem(c.env.DB, itemId, dataset.id);
  if (!deleted) return c.json({ error: "not_found" }, 404);
  if (c.env.CAPTURES) {
    try {
      await c.env.CAPTURES.delete(item.r2_key);
    } catch (e) {
      console.error("dataset_item_r2_delete_failed", item.r2_key, e);
    }
  }
  return c.json({ ok: true });
}

/**
 * GET /v1/datasets/:slug/items/:itemId/file
 *
 * Owner-only proxy read. Datasets are private by default and, unlike
 * models, have no cross-owner slug lookup yet (see getDatasetHandler) —
 * a `visibility: 'public'` dataset is a stated intent for a future
 * public browsing surface, not yet a working cross-owner read path.
 * Building that means resolving a slug globally rather than per-owner,
 * which needs its own uniqueness scope; deliberately deferred rather
 * than half-wired here.
 */
export async function getDatasetItemFileHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  if (!c.env.CAPTURES) return c.json({ error: "storage_unconfigured" }, 503);

  const itemId = parseInt(c.req.param("itemId") || "", 10);
  if (!itemId || Number.isNaN(itemId)) return badRequest(c, "invalid_item_id");
  const item = await getDatasetItem(c.env.DB, itemId);
  if (!item || item.dataset_id !== dataset.id) return c.json({ error: "not_found" }, 404);

  const obj = await c.env.CAPTURES.get(item.r2_key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

interface TrainBody {
  base_model?: unknown;
  training_method?: unknown;
  render_price_tokens?: unknown;
  idempotency_key?: unknown;
}

const RENDER_PRICE_MAX = 100_000;

/**
 * POST /v1/datasets/:slug/train
 *
 * Debit → enqueue. A render_models shell is created eagerly (private
 * visibility) so the job has a version to publish onto the moment
 * training succeeds; the creator makes it public later from the model
 * registry, same as any other model.
 */
export async function trainHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const session = getAuthUser(c);

  if (dataset.item_count < MIN_TRAIN_ITEMS) {
    return c.json(
      { error: "not_enough_items", detail: { min: MIN_TRAIN_ITEMS, have: dataset.item_count } },
      422,
    );
  }

  let body: TrainBody;
  try {
    body = await c.req.json<TrainBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  if (!isTrainableBaseModel(body.base_model)) {
    return badRequest(c, "invalid_base_model", {
      allowed: Object.keys(TRAINABLE_BASE_MODELS),
    });
  }
  const trainingMethod =
    typeof body.training_method === "string" ? body.training_method : "";
  if (!["lora", "dreambooth", "full_finetune"].includes(trainingMethod)) {
    return badRequest(c, "invalid_training_method");
  }
  let renderPriceTokens = 25;
  if (body.render_price_tokens !== undefined && body.render_price_tokens !== null) {
    const n = typeof body.render_price_tokens === "number" ? Math.trunc(body.render_price_tokens) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > RENDER_PRICE_MAX) {
      return badRequest(c, "invalid_render_price_tokens", { max: RENDER_PRICE_MAX });
    }
    renderPriceTokens = n;
  }

  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
      ? `train:${session.uid}:${body.idempotency_key.slice(0, 128)}`
      : `train:${session.uid}:${crypto.randomUUID()}`;

  const existingJob = await getTrainingJobByIdempotencyKey(c.env.DB, idempotencyKey);
  if (existingJob) {
    return c.json({ job: publicTrainingJob(existingJob), replayed: true });
  }

  const priceTokens = trainingPriceTokens(trainingMethod);
  const debit = await applyLedgerEntry(c.env.DB, {
    userId: session.uid,
    delta: -priceTokens,
    kind: "debit",
    idempotencyKey: `${idempotencyKey}:debit`,
    refKind: "training_job",
    refId: null,
    memo: `train: ${dataset.title} (${TRAINABLE_BASE_MODELS[body.base_model].label})`,
  });
  if (debit.status === "insufficient") {
    return c.json(
      { error: "insufficient_balance", balance: debit.balance, shortfall: debit.shortfall },
      402,
    );
  }

  const modelSlug = await uniqueModelSlug(c.env.DB, `${dataset.title} model`);
  const model = await insertModel(c.env.DB, {
    ownerId: session.uid,
    slug: modelSlug,
    title: `${dataset.title} — ${TRAINABLE_BASE_MODELS[body.base_model].label}`,
    description: dataset.description,
    kind: "image",
    provider: "fal_custom",
    visibility: "private",
  });

  const job = await insertTrainingJob(c.env.DB, {
    userId: session.uid,
    datasetId: dataset.id,
    baseModel: body.base_model,
    trainingMethod,
    priceTokens,
    renderPriceTokens,
    modelId: model.id,
    idempotencyKey,
  });

  // TRAINING_MOCK completes synchronously in-request (no network, no
  // cron wait) — see ai/training.ts for why this mirrors RENDER_MOCK
  // rather than simulating cron timing. completeJob's UPDATE is
  // guarded on status='training' (matching the real dispatch/poll
  // state machine), so the mock path must transition the job through
  // 'training' first — completeJob is not itself a queued->succeeded
  // shortcut.
  if (isTrainingMock(c.env)) {
    await markTrainingSubmitted(c.env.DB, job.id, `mock-request-${job.id}`);
    const mock = await runMockTraining(dataset.slug, job.id);
    const submitted = await getTrainingJobById(c.env.DB, job.id);
    await completeJob(c.env, submitted ?? job, mock.weightsRef, dataset.description);
    const finished = await getTrainingJobById(c.env.DB, job.id);
    return c.json({ job: publicTrainingJob(finished ?? job) }, 201);
  }

  return c.json({ job: publicTrainingJob(job) }, 201);
}

const JOB_LIST_DEFAULT = 20;
const JOB_LIST_MAX = 50;

/** GET /v1/training?limit=&before= — the caller's own jobs. */
export async function myTrainingJobsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = JOB_LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > JOB_LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: JOB_LIST_MAX });
    }
    limit = n;
  }
  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;
  if (beforeRaw) {
    const n = parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) return badRequest(c, "invalid_before");
    before = n;
  }
  const rows = await listTrainingJobsByUser(c.env.DB, session.uid, limit, before);
  return c.json({
    jobs: rows.map(publicTrainingJob),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

/** GET /v1/datasets/:slug/training — jobs run against this dataset. */
export async function datasetTrainingJobsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const dataset = await loadOwnedDataset(c);
  if (!dataset) return c.json({ error: "not_found" }, 404);
  const rows = await listTrainingJobsByDataset(c.env.DB, dataset.id);
  return c.json({ jobs: rows.map(publicTrainingJob) });
}

/** GET /v1/training/:id — owner-only job detail. */
export async function getTrainingJobHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const job = await getTrainingJobById(c.env.DB, id);
  if (!job) return c.json({ error: "not_found" }, 404);
  if (job.user_id !== session.uid) return c.json({ error: "forbidden" }, 403);
  return c.json({ job: publicTrainingJob(job) });
}
