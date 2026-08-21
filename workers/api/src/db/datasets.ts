import type { D1Database } from "@cloudflare/workers-types";

/**
 * Dataset Library: a creator's own curated images/video, and the
 * training jobs that consume a dataset to produce a render-model
 * version. See migrations/0020_dataset_library.sql.
 */

export const RIGHTS_DECLARATIONS = [
  "own",
  "licensed",
  "public_domain",
] as const;
export type RightsDeclaration = (typeof RIGHTS_DECLARATIONS)[number];

export function isRightsDeclaration(v: unknown): v is RightsDeclaration {
  return (
    typeof v === "string" &&
    (RIGHTS_DECLARATIONS as readonly string[]).includes(v)
  );
}

export const DATASET_VISIBILITIES = ["private", "public"] as const;
export type DatasetVisibility = (typeof DATASET_VISIBILITIES)[number];

export function isDatasetVisibility(v: unknown): v is DatasetVisibility {
  return (
    typeof v === "string" &&
    (DATASET_VISIBILITIES as readonly string[]).includes(v)
  );
}

export const ITEM_KINDS = ["image", "video"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(v: unknown): v is ItemKind {
  return typeof v === "string" && (ITEM_KINDS as readonly string[]).includes(v);
}

export interface DatasetRow {
  id: number;
  owner_id: number;
  slug: string;
  title: string;
  description: string | null;
  rights_declaration: string;
  visibility: string;
  item_count: number;
  created_at: number;
  updated_at: number;
}

export async function insertDataset(
  db: D1Database,
  input: {
    ownerId: number;
    slug: string;
    title: string;
    description: string | null;
    rightsDeclaration: RightsDeclaration;
    visibility: DatasetVisibility;
  },
): Promise<DatasetRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO datasets
         (owner_id, slug, title, description, rights_declaration,
          visibility, item_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.ownerId,
      input.slug,
      input.title,
      input.description,
      input.rightsDeclaration,
      input.visibility,
      now,
      now,
    )
    .first<DatasetRow>();
  if (!row) throw new Error("insertDataset returned no row");
  return row;
}

export async function getDatasetByOwnerAndSlug(
  db: D1Database,
  ownerId: number,
  slug: string,
): Promise<DatasetRow | null> {
  return await db
    .prepare(`SELECT * FROM datasets WHERE owner_id = ? AND slug = ?`)
    .bind(ownerId, slug)
    .first<DatasetRow>();
}

export async function getDatasetById(
  db: D1Database,
  id: number,
): Promise<DatasetRow | null> {
  return await db
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(id)
    .first<DatasetRow>();
}

export async function updateDataset(
  db: D1Database,
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    rightsDeclaration?: RightsDeclaration;
    visibility?: DatasetVisibility;
  },
): Promise<DatasetRow | null> {
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
  if (patch.rightsDeclaration !== undefined) {
    sets.push("rights_declaration = ?");
    binds.push(patch.rightsDeclaration);
  }
  if (patch.visibility !== undefined) {
    sets.push("visibility = ?");
    binds.push(patch.visibility);
  }
  if (sets.length === 0) {
    return await db
      .prepare(`SELECT * FROM datasets WHERE id = ?`)
      .bind(id)
      .first<DatasetRow>();
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000), id);
  return await db
    .prepare(`UPDATE datasets SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...binds)
    .first<DatasetRow>();
}

export async function listDatasetsByOwner(
  db: D1Database,
  ownerId: number,
): Promise<DatasetRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM datasets WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 200`,
    )
    .bind(ownerId)
    .all<DatasetRow>();
  return results ?? [];
}

export function publicDataset(d: DatasetRow) {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    description: d.description,
    rights_declaration: d.rights_declaration,
    visibility: d.visibility,
    item_count: d.item_count,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface DatasetItemRow {
  id: number;
  dataset_id: number;
  r2_key: string;
  kind: string;
  caption: string | null;
  content_hash: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  status: string;
  flag_reason: string | null;
  created_at: number;
}

export type InsertItemResult =
  | { status: "inserted"; item: DatasetItemRow }
  | { status: "duplicate"; existing: DatasetItemRow };

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

/**
 * Inserts an item and bumps the dataset's denormalised item_count in
 * the same D1 batch. UNIQUE(dataset_id, content_hash) is the dedup
 * mechanism — a byte-identical re-upload/import fails the insert and
 * this returns the existing row instead, rather than double-counting.
 */
export async function insertDatasetItem(
  db: D1Database,
  input: {
    datasetId: number;
    r2Key: string;
    kind: ItemKind;
    caption: string | null;
    contentHash: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    status: "ready" | "flagged";
    flagReason: string | null;
  },
): Promise<InsertItemResult> {
  const now = Math.floor(Date.now() / 1000);
  const insertItem = db
    .prepare(
      `INSERT INTO dataset_items
         (dataset_id, r2_key, kind, caption, content_hash, byte_size,
          width, height, duration_seconds, status, flag_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.datasetId,
      input.r2Key,
      input.kind,
      input.caption,
      input.contentHash,
      input.byteSize,
      input.width,
      input.height,
      input.durationSeconds,
      input.status,
      input.flagReason,
      now,
    );
  const bumpCount = db
    .prepare(
      `UPDATE datasets SET item_count = item_count + 1, updated_at = ? WHERE id = ?`,
    )
    .bind(now, input.datasetId);

  try {
    const results = await db.batch<DatasetItemRow>([insertItem, bumpCount]);
    const item = results[0]?.results?.[0];
    if (!item) throw new Error("insertDatasetItem returned no row");
    return { status: "inserted", item };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await db
        .prepare(
          `SELECT * FROM dataset_items WHERE dataset_id = ? AND content_hash = ?`,
        )
        .bind(input.datasetId, input.contentHash)
        .first<DatasetItemRow>();
      if (existing) return { status: "duplicate", existing };
    }
    throw e;
  }
}

export async function listDatasetItems(
  db: D1Database,
  datasetId: number,
  limit: number,
  before?: number,
): Promise<DatasetItemRow[]> {
  const sql = before
    ? `SELECT * FROM dataset_items WHERE dataset_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM dataset_items WHERE dataset_id = ?
        ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  const bound = before
    ? stmt.bind(datasetId, before, limit)
    : stmt.bind(datasetId, limit);
  const { results } = await bound.all<DatasetItemRow>();
  return results ?? [];
}

export async function getDatasetItem(
  db: D1Database,
  itemId: number,
): Promise<DatasetItemRow | null> {
  return await db
    .prepare(`SELECT * FROM dataset_items WHERE id = ?`)
    .bind(itemId)
    .first<DatasetItemRow>();
}

/** Deletes an item and decrements item_count in the same batch. */
export async function deleteDatasetItem(
  db: D1Database,
  itemId: number,
  datasetId: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const del = db
    .prepare(`DELETE FROM dataset_items WHERE id = ? AND dataset_id = ?`)
    .bind(itemId, datasetId);
  const decCount = db
    .prepare(
      `UPDATE datasets
          SET item_count = MAX(0, item_count - 1), updated_at = ?
        WHERE id = ?`,
    )
    .bind(now, datasetId);
  const results = await db.batch([del, decCount]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export function publicDatasetItem(i: DatasetItemRow) {
  return {
    id: i.id,
    kind: i.kind,
    caption: i.caption,
    byte_size: i.byte_size,
    width: i.width,
    height: i.height,
    duration_seconds: i.duration_seconds,
    status: i.status,
    flag_reason: i.flag_reason,
    created_at: i.created_at,
  };
}

// ---------------------------------------------------------------------------
// Training jobs
// ---------------------------------------------------------------------------

export const TRAINING_JOB_STATUSES = [
  "queued",
  "training",
  "succeeded",
  "failed",
] as const;
export type TrainingJobStatus = (typeof TRAINING_JOB_STATUSES)[number];

export interface TrainingJobRow {
  id: number;
  user_id: number;
  dataset_id: number;
  base_model: string;
  training_method: string;
  price_tokens: number;
  render_price_tokens: number;
  status: string;
  provider_job_id: string | null;
  model_id: number | null;
  model_version_id: number | null;
  error_code: string | null;
  idempotency_key: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export async function insertTrainingJob(
  db: D1Database,
  input: {
    userId: number;
    datasetId: number;
    baseModel: string;
    trainingMethod: string;
    priceTokens: number;
    renderPriceTokens: number;
    modelId: number;
    idempotencyKey: string;
  },
): Promise<TrainingJobRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `INSERT INTO training_jobs
         (user_id, dataset_id, base_model, training_method, price_tokens,
          render_price_tokens, status, model_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.userId,
      input.datasetId,
      input.baseModel,
      input.trainingMethod,
      input.priceTokens,
      input.renderPriceTokens,
      input.modelId,
      input.idempotencyKey,
      now,
    )
    .first<TrainingJobRow>();
  if (!row) throw new Error("insertTrainingJob returned no row");
  return row;
}

export async function getTrainingJobByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<TrainingJobRow | null> {
  return await db
    .prepare(`SELECT * FROM training_jobs WHERE idempotency_key = ?`)
    .bind(key)
    .first<TrainingJobRow>();
}

export async function getTrainingJobById(
  db: D1Database,
  id: number,
): Promise<TrainingJobRow | null> {
  return await db
    .prepare(`SELECT * FROM training_jobs WHERE id = ?`)
    .bind(id)
    .first<TrainingJobRow>();
}

export async function listTrainingJobsByUser(
  db: D1Database,
  userId: number,
  limit: number,
  before?: number,
): Promise<TrainingJobRow[]> {
  const sql = before
    ? `SELECT * FROM training_jobs WHERE user_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM training_jobs WHERE user_id = ?
        ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  const bound = before
    ? stmt.bind(userId, before, limit)
    : stmt.bind(userId, limit);
  const { results } = await bound.all<TrainingJobRow>();
  return results ?? [];
}

export async function listTrainingJobsByDataset(
  db: D1Database,
  datasetId: number,
): Promise<TrainingJobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM training_jobs WHERE dataset_id = ? ORDER BY id DESC LIMIT 200`,
    )
    .bind(datasetId)
    .all<TrainingJobRow>();
  return results ?? [];
}

/** Cron dispatch: jobs that haven't been submitted to the provider yet. */
export async function getQueuedTrainingJobs(
  db: D1Database,
  limit: number,
): Promise<TrainingJobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM training_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT ?`,
    )
    .bind(limit)
    .all<TrainingJobRow>();
  return results ?? [];
}

/** Cron poll: jobs already submitted, awaiting a provider result. */
export async function getInFlightTrainingJobs(
  db: D1Database,
  limit: number,
): Promise<TrainingJobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM training_jobs WHERE status = 'training' ORDER BY id ASC LIMIT ?`,
    )
    .bind(limit)
    .all<TrainingJobRow>();
  return results ?? [];
}

export async function markTrainingSubmitted(
  db: D1Database,
  id: number,
  providerJobId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE training_jobs
          SET status = 'training', provider_job_id = ?, started_at = ?
        WHERE id = ? AND status = 'queued'`,
    )
    .bind(providerJobId, Math.floor(Date.now() / 1000), id)
    .run();
}

export async function finishTrainingJob(
  db: D1Database,
  id: number,
  patch: {
    status: "succeeded" | "failed";
    modelVersionId?: number | null;
    errorCode?: string | null;
  },
): Promise<TrainingJobRow | null> {
  return await db
    .prepare(
      `UPDATE training_jobs
          SET status = ?, model_version_id = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'training'
        RETURNING *`,
    )
    .bind(
      patch.status,
      patch.modelVersionId ?? null,
      patch.errorCode ?? null,
      Math.floor(Date.now() / 1000),
      id,
    )
    .first<TrainingJobRow>();
}

export function publicTrainingJob(j: TrainingJobRow) {
  return {
    id: j.id,
    dataset_id: j.dataset_id,
    base_model: j.base_model,
    training_method: j.training_method,
    price_tokens: j.price_tokens,
    render_price_tokens: j.render_price_tokens,
    status: j.status,
    model_id: j.model_id,
    model_version_id: j.model_version_id,
    error_code: j.error_code,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
  };
}
