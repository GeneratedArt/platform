-- Dataset Library: a creator's own curated images/video, and the
-- training jobs that turn a dataset + base model into a published
-- render-model version (see migrations/0019_custom_model_provider.sql).
--
-- Lifecycle: a dataset is uploaded to and curated privately, then a
-- training job consumes it to produce an immutable render_model_versions
-- row (weights_ref pointing at the trained checkpoint/LoRA). The dataset
-- itself is never deleted or mutated by training — the same item set can
-- back many training jobs across many base models (this is the "one
-- dataset, many models" comparison feature).

CREATE TABLE IF NOT EXISTS datasets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug               TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  -- The creator's curatorial statement — what this visual world is and
  -- why it was collected. Becomes the public dataset_note on any model
  -- version trained from this set (see publishVersionHandler).
  description        TEXT,
  -- own | licensed | public_domain — a required, plain-language
  -- self-declaration, not a verification step. See handler comment for
  -- why there's no CHECK constraint enforcing the exact string set here.
  rights_declaration TEXT    NOT NULL,
  -- private | public. Private by default — a dataset is source material,
  -- not a publication. Publishing a dataset (making its item grid
  -- visible) is a distinct, deliberate act from publishing a model
  -- trained on it.
  visibility         TEXT    NOT NULL DEFAULT 'private',
  -- Denormalised so the library grid renders without a per-card COUNT
  -- query. Kept in sync by insertDatasetItem/deleteDatasetItem in the
  -- same statement, not via a trigger, so it stays visible in git blame.
  item_count         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_datasets_owner
  ON datasets(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dataset_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id     INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  r2_key         TEXT    NOT NULL UNIQUE,
  -- image | video
  kind           TEXT    NOT NULL,
  caption        TEXT,
  -- sha256 of the stored bytes. UNIQUE per dataset is the platform's
  -- dedup mechanism — an exact re-upload (the common case: the same
  -- file dragged in twice, or re-imported from a URL list that
  -- overlaps a previous import) is rejected at the DB layer rather
  -- than silently duplicated. Near-duplicate (perceptually similar,
  -- not byte-identical) detection is a deliberate v2 scope cut — it
  -- needs a perceptual hash, not a content hash — flagged in the
  -- handler, not silently absent.
  content_hash   TEXT    NOT NULL,
  byte_size      INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  duration_seconds REAL,
  -- ready | flagged. There's no async "processing" stage yet — an item
  -- is either accepted (ready) or rejected with a reason (flagged) at
  -- upload/import time, since this Worker can't run a background
  -- thumbnailing/transcoding pipeline. `flag_reason` is the specific
  -- cause (unsupported codec, corrupt file, too small) referenced by
  -- the design's "flagged items" state.
  status         TEXT    NOT NULL DEFAULT 'ready',
  flag_reason    TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (dataset_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset
  ON dataset_items(dataset_id, id DESC);

CREATE TABLE IF NOT EXISTS training_jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dataset_id         INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  base_model         TEXT    NOT NULL,
  -- lora | dreambooth | full_finetune (see TRAINING_METHODS in
  -- src/db/render.ts — reused here, not redefined).
  training_method    TEXT    NOT NULL,
  price_tokens       INTEGER NOT NULL,
  -- What the resulting model version should charge per render, chosen
  -- by the creator at train time so it's ready to publish the moment
  -- training succeeds rather than defaulting to free.
  render_price_tokens INTEGER NOT NULL DEFAULT 25,
  -- queued | training | succeeded | failed
  status             TEXT    NOT NULL DEFAULT 'queued',
  -- fal.ai's queue request_id once submitted. Null while queued.
  provider_job_id    TEXT,
  -- Populated on submit: the render_models shell this job will publish
  -- a version onto. Created eagerly (status='private') so a job in
  -- progress has somewhere to point before it succeeds.
  model_id           INTEGER REFERENCES render_models(id),
  -- Populated on success: the immutable version the job produced.
  model_version_id   INTEGER REFERENCES render_model_versions(id),
  error_code         TEXT,
  idempotency_key    TEXT    NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_training_jobs_user
  ON training_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_jobs_dataset
  ON training_jobs(dataset_id, created_at DESC);
-- Cron dispatch/poll scans by status; this keeps both bounded lookups
-- (getQueuedTrainingJobs, getInFlightTrainingJobs) index-only.
CREATE INDEX IF NOT EXISTS idx_training_jobs_status
  ON training_jobs(status, id ASC);
