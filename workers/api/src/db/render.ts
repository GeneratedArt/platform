import type { D1Database } from "@cloudflare/workers-types";
import { slugify } from "../lib/slug";

/**
 * Custom render models and the jobs run against them.
 *
 * A model is a creator-published recipe (provider + system prompt +
 * parameter schema + price). Versions are immutable: a job stores the
 * version id it ran against, so editing a published version in place
 * would rewrite the provenance of every earlier job.
 */

export const MODEL_KINDS = ["code", "image"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

// `fal_custom` — a creator-trained custom art model (fine-tuned
// checkpoint or LoRA on a diffusion base), run through fal.ai's private-
// model inference. This is the platform's Refik-Anadol-style lane: a
// bespoke model trained on a curated dataset, distinct from prompting a
// fixed catalogue model. See migrations/0019_custom_model_provider.sql
// for why Workers AI can't host it (its LoRA fine-tuning is text-only).
export const MODEL_PROVIDERS = [
  "anthropic",
  "workers_ai",
  "fal_custom",
  "mock",
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const TRAINING_METHODS = [
  "prompt_recipe",
  "lora",
  "dreambooth",
  "full_finetune",
] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];

export function isTrainingMethod(v: unknown): v is TrainingMethod {
  return (
    typeof v === "string" && (TRAINING_METHODS as readonly string[]).includes(v)
  );
}

export const MODEL_VISIBILITIES = ["public", "unlisted", "private"] as const;
export type ModelVisibility = (typeof MODEL_VISIBILITIES)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function isModelKind(v: unknown): v is ModelKind {
  return typeof v === "string" && (MODEL_KINDS as readonly string[]).includes(v);
}
export function isModelProvider(v: unknown): v is ModelProvider {
  return (
    typeof v === "string" &&
    (MODEL_PROVIDERS as readonly string[]).includes(v)
  );
}
export function isModelVisibility(v: unknown): v is ModelVisibility {
  return (
    typeof v === "string" &&
    (MODEL_VISIBILITIES as readonly string[]).includes(v)
  );
}

/**
 * Which provider each model kind is allowed to use.
 *
 * Enforced at registration time rather than at render time: an image
 * model pointed at the code provider would only fail once someone had
 * already been charged for the job.
 */
export const PROVIDERS_BY_KIND: Record<ModelKind, readonly ModelProvider[]> = {
  code: ["anthropic", "mock"],
  image: ["workers_ai", "fal_custom", "mock"],
};

export function providerAllowedForKind(
  kind: ModelKind,
  provider: ModelProvider,
): boolean {
  return PROVIDERS_BY_KIND[kind].includes(provider);
}

export interface ModelRow {
  id: number;
  owner_id: number;
  slug: string;
  title: string;
  description: string | null;
  kind: string;
  provider: string;
  visibility: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ModelVersionRow {
  id: number;
  model_id: number;
  version: number;
  provider_model_id: string;
  system_prompt: string | null;
  params_schema_json: string | null;
  price_tokens: number;
  created_at: number;
  // Training lineage — see migrations/0019_custom_model_provider.sql.
  // Null for anthropic/workers_ai versions; populated for fal_custom.
  training_method: string | null;
  base_model: string | null;
  dataset_note: string | null;
  weights_ref: string | null;
}

export interface ModelListItem extends ModelRow {
  owner_handle: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  latest_version: number | null;
  latest_price_tokens: number | null;
  run_count: number;
}

export async function uniqueModelSlug(
  db: D1Database,
  base: string,
): Promise<string> {
  const baseSlug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    const taken = await db
      .prepare("SELECT 1 FROM render_models WHERE slug = ?")
      .bind(candidate)
      .first();
    if (!taken) return candidate;
  }
  return `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function insertModel(
  db: D1Database,
  input: {
    ownerId: number;
    slug: string;
    title: string;
    description: string | null;
    kind: ModelKind;
    provider: ModelProvider;
    visibility: ModelVisibility;
  },
): Promise<ModelRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO render_models
         (owner_id, slug, title, description, kind, provider, visibility,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       RETURNING *`,
    )
    .bind(
      input.ownerId,
      input.slug,
      input.title,
      input.description,
      input.kind,
      input.provider,
      input.visibility,
      now,
      now,
    )
    .first<ModelRow>();
  if (!row) throw new Error("insertModel returned no row");
  return row;
}

export async function getModelBySlug(
  db: D1Database,
  slug: string,
): Promise<ModelRow | null> {
  return await db
    .prepare(`SELECT * FROM render_models WHERE slug = ?`)
    .bind(slug)
    .first<ModelRow>();
}

export async function updateModel(
  db: D1Database,
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    visibility?: ModelVisibility;
    status?: "active" | "disabled";
  },
): Promise<ModelRow | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.visibility !== undefined) {
    sets.push("visibility = ?");
    binds.push(patch.visibility);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (sets.length === 0) {
    return await db
      .prepare(`SELECT * FROM render_models WHERE id = ?`)
      .bind(id)
      .first<ModelRow>();
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000), id);
  return await db
    .prepare(
      `UPDATE render_models SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    )
    .bind(...binds)
    .first<ModelRow>();
}

/**
 * Public listing: `public` + `active` models only, newest first, with
 * the owner joined and the latest version's price denormalised so the
 * catalogue renders without an N+1.
 */
export async function listPublicModels(
  db: D1Database,
  opts: { kind?: ModelKind; limit: number; before?: number },
): Promise<ModelListItem[]> {
  const where: string[] = [
    "m.visibility = 'public'",
    "m.status = 'active'",
  ];
  const binds: unknown[] = [];
  if (opts.kind) {
    where.push("m.kind = ?");
    binds.push(opts.kind);
  }
  if (opts.before) {
    where.push("m.updated_at < ?");
    binds.push(opts.before);
  }
  binds.push(opts.limit);
  const { results } = await db
    .prepare(
      `SELECT m.*,
              u.handle       AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar_url   AS owner_avatar_url,
              (SELECT MAX(version) FROM render_model_versions v
                WHERE v.model_id = m.id)               AS latest_version,
              (SELECT v.price_tokens FROM render_model_versions v
                WHERE v.model_id = m.id
                ORDER BY v.version DESC LIMIT 1)       AS latest_price_tokens,
              (SELECT COUNT(*) FROM render_jobs j
                 JOIN render_model_versions v2 ON v2.id = j.model_version_id
                WHERE v2.model_id = m.id AND j.status = 'succeeded')
                                                       AS run_count
         FROM render_models m
         JOIN users u ON u.id = m.owner_id
        WHERE ${where.join(" AND ")}
        ORDER BY m.updated_at DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<ModelListItem>();
  return results ?? [];
}

export async function listModelsByOwner(
  db: D1Database,
  ownerId: number,
): Promise<ModelListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*,
              u.handle       AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar_url   AS owner_avatar_url,
              (SELECT MAX(version) FROM render_model_versions v
                WHERE v.model_id = m.id)               AS latest_version,
              (SELECT v.price_tokens FROM render_model_versions v
                WHERE v.model_id = m.id
                ORDER BY v.version DESC LIMIT 1)       AS latest_price_tokens,
              (SELECT COUNT(*) FROM render_jobs j
                 JOIN render_model_versions v2 ON v2.id = j.model_version_id
                WHERE v2.model_id = m.id AND j.status = 'succeeded')
                                                       AS run_count
         FROM render_models m
         JOIN users u ON u.id = m.owner_id
        WHERE m.owner_id = ?
        ORDER BY m.updated_at DESC
        LIMIT 200`,
    )
    .bind(ownerId)
    .all<ModelListItem>();
  return results ?? [];
}

/**
 * Appends an immutable version. `version` is allocated server-side as
 * MAX+1 rather than taken from the caller, so two concurrent publishes
 * can't both claim v3 — the UNIQUE(model_id, version) index turns that
 * race into a constraint error the handler retries.
 */
export async function insertModelVersion(
  db: D1Database,
  input: {
    modelId: number;
    providerModelId: string;
    systemPrompt: string | null;
    paramsSchemaJson: string | null;
    priceTokens: number;
    trainingMethod?: string | null;
    baseModel?: string | null;
    datasetNote?: string | null;
    weightsRef?: string | null;
  },
): Promise<ModelVersionRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO render_model_versions
         (model_id, version, provider_model_id, system_prompt,
          params_schema_json, price_tokens, training_method, base_model,
          dataset_note, weights_ref, created_at)
       SELECT ?,
              COALESCE((SELECT MAX(version) FROM render_model_versions
                         WHERE model_id = ?), 0) + 1,
              ?, ?, ?, ?, ?, ?, ?, ?, ?
       RETURNING *`,
    )
    .bind(
      input.modelId,
      input.modelId,
      input.providerModelId,
      input.systemPrompt,
      input.paramsSchemaJson,
      input.priceTokens,
      input.trainingMethod ?? null,
      input.baseModel ?? null,
      input.datasetNote ?? null,
      input.weightsRef ?? null,
      now,
    )
    .first<ModelVersionRow>();
  if (!row) throw new Error("insertModelVersion returned no row");
  // Surface the new version on the catalogue's sort key.
  await db
    .prepare(`UPDATE render_models SET updated_at = ? WHERE id = ?`)
    .bind(now, input.modelId)
    .run();
  return row;
}

export async function listModelVersions(
  db: D1Database,
  modelId: number,
): Promise<ModelVersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM render_model_versions
        WHERE model_id = ? ORDER BY version DESC LIMIT 100`,
    )
    .bind(modelId)
    .all<ModelVersionRow>();
  return results ?? [];
}

export async function getModelVersion(
  db: D1Database,
  versionId: number,
): Promise<ModelVersionRow | null> {
  return await db
    .prepare(`SELECT * FROM render_model_versions WHERE id = ?`)
    .bind(versionId)
    .first<ModelVersionRow>();
}

export async function getLatestModelVersion(
  db: D1Database,
  modelId: number,
): Promise<ModelVersionRow | null> {
  return await db
    .prepare(
      `SELECT * FROM render_model_versions
        WHERE model_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(modelId)
    .first<ModelVersionRow>();
}

export function publicModel(m: ModelRow, extra?: Partial<ModelListItem>) {
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    description: m.description,
    kind: m.kind,
    provider: m.provider,
    visibility: m.visibility,
    status: m.status,
    created_at: m.created_at,
    updated_at: m.updated_at,
    latest_version: extra?.latest_version ?? null,
    latest_price_tokens: extra?.latest_price_tokens ?? null,
    run_count: extra?.run_count ?? 0,
    owner: extra?.owner_handle
      ? {
          handle: extra.owner_handle,
          display_name: extra.owner_display_name ?? null,
          avatar_url: extra.owner_avatar_url ?? null,
        }
      : undefined,
  };
}

export function publicModelVersion(v: ModelVersionRow, includePrompt = false) {
  return {
    id: v.id,
    version: v.version,
    provider_model_id: v.provider_model_id,
    // `system_prompt` is the creator's authored work and the thing a
    // competing publisher would copy — omitted for every viewer except
    // the model's own owner (includePrompt), who gets it back so they
    // can review/iterate on what they published.
    system_prompt: includePrompt ? v.system_prompt : undefined,
    params_schema: v.params_schema_json
      ? safeParse(v.params_schema_json)
      : null,
    price_tokens: v.price_tokens,
    // Training lineage is the provenance disclosure for a custom model
    // (the Anadol-style "what this was trained on") — shown to every
    // viewer, same as a project's frozen CID. `weights_ref` is the
    // pointer to the actual trained weights at the provider; gated
    // owner-only like system_prompt, since it's what another creator
    // would need to clone the model outright.
    training_method: v.training_method,
    base_model: v.base_model,
    dataset_note: v.dataset_note,
    weights_ref: includePrompt ? v.weights_ref : undefined,
    created_at: v.created_at,
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobRow {
  id: number;
  user_id: number;
  model_version_id: number;
  project_id: number | null;
  seed: string;
  params_json: string | null;
  prompt_hash: string | null;
  status: string;
  price_tokens: number;
  owner_earn_tokens: number;
  output_kind: string | null;
  output_text: string | null;
  output_key: string | null;
  output_hash: string | null;
  error_code: string | null;
  idempotency_key: string;
  created_at: number;
  finished_at: number | null;
}

export async function insertJob(
  db: D1Database,
  input: {
    userId: number;
    modelVersionId: number;
    projectId: number | null;
    seed: string;
    paramsJson: string | null;
    promptHash: string | null;
    priceTokens: number;
    ownerEarnTokens: number;
    idempotencyKey: string;
  },
): Promise<JobRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO render_jobs
         (user_id, model_version_id, project_id, seed, params_json,
          prompt_hash, status, price_tokens, owner_earn_tokens,
          idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.userId,
      input.modelVersionId,
      input.projectId,
      input.seed,
      input.paramsJson,
      input.promptHash,
      input.priceTokens,
      input.ownerEarnTokens,
      input.idempotencyKey,
      now,
    )
    .first<JobRow>();
  if (!row) throw new Error("insertJob returned no row");
  return row;
}

export async function getJobByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<JobRow | null> {
  return await db
    .prepare(`SELECT * FROM render_jobs WHERE idempotency_key = ?`)
    .bind(key)
    .first<JobRow>();
}

export async function getJobById(
  db: D1Database,
  id: number,
): Promise<JobRow | null> {
  return await db
    .prepare(`SELECT * FROM render_jobs WHERE id = ?`)
    .bind(id)
    .first<JobRow>();
}

export async function finishJob(
  db: D1Database,
  id: number,
  patch: {
    status: "succeeded" | "failed";
    outputKind?: string | null;
    outputText?: string | null;
    outputKey?: string | null;
    outputHash?: string | null;
    errorCode?: string | null;
  },
): Promise<JobRow | null> {
  return await db
    .prepare(
      `UPDATE render_jobs
          SET status = ?, output_kind = ?, output_text = ?, output_key = ?,
              output_hash = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    )
    .bind(
      patch.status,
      patch.outputKind ?? null,
      patch.outputText ?? null,
      patch.outputKey ?? null,
      patch.outputHash ?? null,
      patch.errorCode ?? null,
      Math.floor(Date.now() / 1000),
      id,
    )
    .first<JobRow>();
}

export async function listJobsByUser(
  db: D1Database,
  userId: number,
  limit: number,
  before?: number,
): Promise<JobRow[]> {
  const sql = before
    ? `SELECT * FROM render_jobs WHERE user_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM render_jobs WHERE user_id = ?
        ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  const bound = before
    ? stmt.bind(userId, before, limit)
    : stmt.bind(userId, limit);
  const { results } = await bound.all<JobRow>();
  return results ?? [];
}

export function publicJob(j: JobRow) {
  return {
    id: j.id,
    model_version_id: j.model_version_id,
    project_id: j.project_id,
    seed: j.seed,
    params: j.params_json ? safeParse(j.params_json) : null,
    status: j.status,
    price_tokens: j.price_tokens,
    output_kind: j.output_kind,
    output_text: j.output_text,
    output_key: j.output_key,
    output_hash: j.output_hash,
    error_code: j.error_code,
    created_at: j.created_at,
    finished_at: j.finished_at,
  };
}
