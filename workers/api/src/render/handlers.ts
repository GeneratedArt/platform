import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { maybeAuthUser } from "../users/handlers";
import { checkRateLimit } from "../lib/rateLimit";
import { getProjectById } from "../db/projects";
import { applyLedgerEntry } from "../db/tokens";
import { runInference, InferenceError } from "../ai/inference";
import {
  isModelKind,
  isModelProvider,
  isModelVisibility,
  providerAllowedForKind,
  uniqueModelSlug,
  insertModel,
  getModelBySlug,
  updateModel,
  listPublicModels,
  listModelsByOwner,
  insertModelVersion,
  listModelVersions,
  getLatestModelVersion,
  getModelVersion,
  publicModel,
  publicModelVersion,
  insertJob,
  getJobByIdempotencyKey,
  getJobById,
  finishJob,
  listJobsByUser,
  publicJob,
  type ModelKind,
} from "../db/render";

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

const TITLE_MAX = 100;
const DESC_MAX = 2000;
const PROMPT_MAX = 4000;
const SYSTEM_PROMPT_MAX = 8000;
const PARAMS_JSON_MAX = 8000;
const PRICE_MAX = 100_000; // ceiling against a fat-fingered pack-draining price
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

interface CreateModelBody {
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  provider?: unknown;
  visibility?: unknown;
}

/** POST /v1/models — register a new (versionless) model shell. */
export async function createModelHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `models:create:${session.uid}`,
    limit: 20,
    windowSeconds: 86400,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CreateModelBody;
  try {
    body = await c.req.json<CreateModelBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) {
    return badRequest(c, "invalid_title", { max: TITLE_MAX });
  }
  if (!isModelKind(body.kind)) {
    return badRequest(c, "invalid_kind");
  }
  if (!isModelProvider(body.provider)) {
    return badRequest(c, "invalid_provider");
  }
  if (!providerAllowedForKind(body.kind, body.provider)) {
    return badRequest(c, "provider_not_allowed_for_kind", {
      kind: body.kind,
      provider: body.provider,
    });
  }
  const visibility = isModelVisibility(body.visibility) ? body.visibility : "private";

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string" || body.description.length > DESC_MAX) {
      return badRequest(c, "invalid_description", { max: DESC_MAX });
    }
    description = body.description.trim() || null;
  }

  let slug: string;
  if (typeof body.slug === "string" && body.slug.length > 0) {
    if (!SLUG_RE.test(body.slug)) return badRequest(c, "invalid_slug");
    const taken = await getModelBySlug(c.env.DB, body.slug);
    if (taken) return badRequest(c, "slug_taken", 409 as never);
    slug = body.slug;
  } else {
    slug = await uniqueModelSlug(c.env.DB, title);
  }

  const model = await insertModel(c.env.DB, {
    ownerId: session.uid,
    slug,
    title,
    description,
    kind: body.kind,
    provider: body.provider,
    visibility,
  });
  return c.json({ model: publicModel(model) }, 201);
}

interface PatchModelBody {
  title?: unknown;
  description?: unknown;
  visibility?: unknown;
  status?: unknown;
}

/** PATCH /v1/models/:slug — owner-only metadata edits. */
export async function patchModelHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const slug = c.req.param("slug") || "";
  const model = await getModelBySlug(c.env.DB, slug);
  if (!model) return c.json({ error: "not_found" }, 404);
  if (model.owner_id !== session.uid) return c.json({ error: "forbidden" }, 403);

  let body: PatchModelBody;
  try {
    body = await c.req.json<PatchModelBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const patch: Parameters<typeof updateModel>[2] = {};
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
  if (body.visibility !== undefined) {
    if (!isModelVisibility(body.visibility)) return badRequest(c, "invalid_visibility");
    patch.visibility = body.visibility;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      return badRequest(c, "invalid_status");
    }
    patch.status = body.status;
  }

  const updated = await updateModel(c.env.DB, model.id, patch);
  return c.json({ model: publicModel(updated ?? model) });
}

const LIST_DEFAULT = 20;
const LIST_MAX = 50;

/** GET /v1/models?kind=&limit=&before= — public catalogue. */
export async function listModelsHandler(c: Context<{ Bindings: Env }>) {
  const url = new URL(c.req.url);
  const kindRaw = url.searchParams.get("kind");
  let kind: ModelKind | undefined;
  if (kindRaw) {
    if (!isModelKind(kindRaw)) return badRequest(c, "invalid_kind");
    kind = kindRaw;
  }
  const limitRaw = url.searchParams.get("limit");
  let limit = LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: LIST_MAX });
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
  const rows = await listPublicModels(c.env.DB, { kind, limit, before });
  return c.json({
    models: rows.map((r) => publicModel(r, r)),
    next_before: rows.length === limit ? rows[rows.length - 1].updated_at : null,
  });
}

/** GET /v1/models/mine — the caller's own models, any visibility/status. */
export async function myModelsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const rows = await listModelsByOwner(c.env.DB, session.uid);
  return c.json({ models: rows.map((r) => publicModel(r, r)) });
}

/** GET /v1/models/:slug — detail + version history. */
export async function getModelHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const slug = c.req.param("slug") || "";
  const model = await getModelBySlug(c.env.DB, slug);
  if (!model) return c.json({ error: "not_found" }, 404);

  const viewer = await maybeAuthUser(c);
  const isOwner = !!viewer && viewer.uid === model.owner_id;
  if (model.visibility === "private" && !isOwner) {
    return c.json({ error: "not_found" }, 404);
  }

  const versions = await listModelVersions(c.env.DB, model.id);
  return c.json({
    model: publicModel(model),
    versions: versions.map((v) => publicModelVersion(v, isOwner)),
  });
}

interface PublishVersionBody {
  provider_model_id?: unknown;
  system_prompt?: unknown;
  params_schema?: unknown;
  price_tokens?: unknown;
}

/** POST /v1/models/:slug/versions — owner-only, append-only publish. */
export async function publishVersionHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const slug = c.req.param("slug") || "";
  const model = await getModelBySlug(c.env.DB, slug);
  if (!model) return c.json({ error: "not_found" }, 404);
  if (model.owner_id !== session.uid) return c.json({ error: "forbidden" }, 403);

  let body: PublishVersionBody;
  try {
    body = await c.req.json<PublishVersionBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const providerModelId =
    typeof body.provider_model_id === "string" ? body.provider_model_id.trim() : "";
  if (!providerModelId || providerModelId.length > 200) {
    return badRequest(c, "invalid_provider_model_id");
  }

  let systemPrompt: string | null = null;
  if (body.system_prompt !== undefined && body.system_prompt !== null) {
    if (typeof body.system_prompt !== "string" || body.system_prompt.length > SYSTEM_PROMPT_MAX) {
      return badRequest(c, "invalid_system_prompt", { max: SYSTEM_PROMPT_MAX });
    }
    systemPrompt = body.system_prompt;
  }

  let paramsSchemaJson: string | null = null;
  if (body.params_schema !== undefined && body.params_schema !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(body.params_schema);
    } catch {
      return badRequest(c, "invalid_params_schema");
    }
    if (serialized.length > PARAMS_JSON_MAX) {
      return badRequest(c, "params_schema_too_large", { max: PARAMS_JSON_MAX });
    }
    paramsSchemaJson = serialized;
  }

  const priceTokens =
    typeof body.price_tokens === "number" ? Math.trunc(body.price_tokens) : NaN;
  if (!Number.isFinite(priceTokens) || priceTokens < 0 || priceTokens > PRICE_MAX) {
    return badRequest(c, "invalid_price_tokens", { max: PRICE_MAX });
  }

  const version = await insertModelVersion(c.env.DB, {
    modelId: model.id,
    providerModelId,
    systemPrompt,
    paramsSchemaJson,
    priceTokens,
  });
  return c.json({ version: publicModelVersion(version, true) }, 201);
}

// ---------------------------------------------------------------------------
// Render jobs
// ---------------------------------------------------------------------------

/**
 * Share of price_tokens credited to the model's owner on a successful
 * run. Skipped when the renderer IS the owner (see the `earn` guard
 * below) — otherwise running your own model would mint tokens out of
 * a debit/credit pair on the same account, net-zero in balance but
 * inflating lifetime_earned for nothing real.
 */
const OWNER_EARN_BPS = 7000; // 70%

function ownerEarn(priceTokens: number): number {
  return Math.floor((priceTokens * OWNER_EARN_BPS) / 10_000);
}

interface RenderBody {
  version_id?: unknown;
  prompt?: unknown;
  params?: unknown;
  project_id?: unknown;
  seed?: unknown;
  idempotency_key?: unknown;
}

function randomSeed(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /v1/models/:slug/render
 *
 * Debit → run → settle. Tokens are debited BEFORE the provider call so
 * a burst of concurrent requests can't spend more than the caller's
 * balance; a failed run is refunded in full as a second ledger entry
 * (see migrations/0018_token_service.sql header) rather than reversing
 * the first.
 */
export async function renderHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const slug = c.req.param("slug") || "";

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `render:${session.uid}`,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  const model = await getModelBySlug(c.env.DB, slug);
  if (!model) return c.json({ error: "not_found" }, 404);
  if (model.status !== "active") return c.json({ error: "model_disabled" }, 409);
  if (model.visibility === "private" && model.owner_id !== session.uid) {
    return c.json({ error: "not_found" }, 404);
  }

  let body: RenderBody;
  try {
    body = await c.req.json<RenderBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > PROMPT_MAX) {
    return badRequest(c, "invalid_prompt", { max: PROMPT_MAX });
  }

  let params: Record<string, unknown> | null = null;
  if (body.params !== undefined && body.params !== null) {
    if (typeof body.params !== "object" || Array.isArray(body.params)) {
      return badRequest(c, "invalid_params");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(body.params);
    } catch {
      return badRequest(c, "invalid_params");
    }
    if (serialized.length > PARAMS_JSON_MAX) {
      return badRequest(c, "params_too_large", { max: PARAMS_JSON_MAX });
    }
    params = body.params as Record<string, unknown>;
  }

  let projectId: number | null = null;
  if (body.project_id !== undefined && body.project_id !== null) {
    projectId = typeof body.project_id === "number" ? body.project_id : NaN;
    if (!Number.isFinite(projectId) || projectId < 1) return badRequest(c, "invalid_project_id");
    const project = await getProjectById(c.env.DB, projectId);
    if (!project || project.owner_id !== session.uid) {
      return badRequest(c, "invalid_project_id");
    }
  }

  const seed =
    typeof body.seed === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.seed)
      ? body.seed
      : randomSeed();

  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
      ? `render:${session.uid}:${body.idempotency_key.slice(0, 128)}`
      : `render:${session.uid}:${crypto.randomUUID()}`;

  const existingJob = await getJobByIdempotencyKey(c.env.DB, idempotencyKey);
  if (existingJob) {
    return c.json({ job: publicJob(existingJob), replayed: true });
  }

  const version = await getLatestModelVersion(c.env.DB, model.id);
  if (!version) return c.json({ error: "no_published_version" }, 409);

  const debit = await applyLedgerEntry(c.env.DB, {
    userId: session.uid,
    delta: -version.price_tokens,
    kind: "debit",
    idempotencyKey: `${idempotencyKey}:debit`,
    refKind: "render_job",
    refId: null,
    memo: `render: ${model.title}`,
  });
  if (debit.status === "insufficient") {
    return c.json(
      { error: "insufficient_balance", balance: debit.balance, shortfall: debit.shortfall },
      402,
    );
  }

  const job = await insertJob(c.env.DB, {
    userId: session.uid,
    modelVersionId: version.id,
    projectId,
    seed,
    paramsJson: params ? JSON.stringify(params) : null,
    promptHash: await sha256Hex(prompt),
    priceTokens: version.price_tokens,
    ownerEarnTokens: ownerEarn(version.price_tokens),
    idempotencyKey,
  });

  try {
    const result = await runInference(c.env, {
      kind: model.kind as ModelKind,
      provider: model.provider as never,
      providerModelId: version.provider_model_id,
      systemPrompt: version.system_prompt,
      prompt,
      params,
      seed,
    });

    let outputKey: string | null = null;
    if (result.outputKind === "image" && result.bytes) {
      if (!c.env.CAPTURES) {
        throw new InferenceError("R2 CAPTURES bucket is not bound", "storage_unconfigured");
      }
      outputKey = `renders/${session.uid}/${job.id}-${seed}.png`;
      await c.env.CAPTURES.put(outputKey, result.bytes, {
        httpMetadata: { contentType: result.contentType ?? "image/png" },
        customMetadata: {
          user_id: String(session.uid),
          job_id: String(job.id),
          model_slug: model.slug,
        },
      });
    }

    const finished = await finishJob(c.env.DB, job.id, {
      status: "succeeded",
      outputKind: result.outputKind,
      outputText: result.text,
      outputKey,
      outputHash: result.outputHash,
    });

    // Owner earn-out on success only — a failed job (refunded below)
    // never pays the model owner for compute that produced nothing.
    if (job.owner_earn_tokens > 0 && model.owner_id !== session.uid) {
      try {
        await applyLedgerEntry(c.env.DB, {
          userId: model.owner_id,
          delta: job.owner_earn_tokens,
          kind: "earn",
          idempotencyKey: `${idempotencyKey}:earn`,
          refKind: "render_job",
          refId: job.id,
          memo: `render earn: ${model.title}`,
        });
      } catch (e) {
        // Best-effort: the renderer's job already succeeded and their
        // tokens were correctly spent. A missed owner credit is
        // recoverable from the ledger's ref_id; it must not roll back
        // a job the caller already sees as done.
        console.error("owner_earn_failed", e);
      }
    }

    return c.json({ job: publicJob(finished ?? job) }, 201);
  } catch (e) {
    const code = e instanceof InferenceError ? e.code : "render_failed";
    const failed = await finishJob(c.env.DB, job.id, {
      status: "failed",
      errorCode: code,
    });
    try {
      await applyLedgerEntry(c.env.DB, {
        userId: session.uid,
        delta: version.price_tokens,
        kind: "refund",
        idempotencyKey: `${idempotencyKey}:refund`,
        refKind: "render_job",
        refId: job.id,
        memo: `refund: ${model.title} (${code})`,
      });
    } catch (refundErr) {
      console.error("refund_failed", refundErr);
    }
    console.error("render_failed", e);
    return c.json({ error: code, job: publicJob(failed ?? job) }, code === "provider_unconfigured" ? 503 : 502);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const JOB_LIST_DEFAULT = 20;
const JOB_LIST_MAX = 50;

/** GET /v1/jobs?limit=&before= — the caller's own render jobs. */
export async function myJobsHandler(
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
  const rows = await listJobsByUser(c.env.DB, session.uid, limit, before);
  return c.json({
    jobs: rows.map(publicJob),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

/** GET /v1/jobs/:id — owner-only job detail. */
export async function getJobHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const job = await getJobById(c.env.DB, id);
  if (!job) return c.json({ error: "not_found" }, 404);
  if (job.user_id !== session.uid) return c.json({ error: "forbidden" }, 403);
  return c.json({ job: publicJob(job) });
}
