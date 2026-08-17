-- Render-token service: prepaid compute credits, a registry of custom
-- render models, and the job rows that spend tokens against them.
--
-- NAMING — read this before touching anything below.
--   A "render token" is a prepaid compute credit. It is NOT an ERC-721
--   token. This codebase already uses `token_id` / `mints.token_id` for
--   on-chain NFTs (see 0001_init.sql and 0014_traits.sql); nothing in
--   this migration touches that. Every table here is about paying for
--   inference, never about minting.
--
-- LEDGER INVARIANT
--   `token_accounts.balance` is a cache. `token_ledger` is the source of
--   truth: an append-only list of signed deltas. Every balance mutation
--   writes exactly one ledger row and updates the cached balance in the
--   SAME D1 batch (batches are transactional), guarded by the identical
--   `balance + delta >= 0` predicate on both statements so they can only
--   apply together. `balance_after` is stamped on each row, so
--   `SELECT balance_after FROM token_ledger ORDER BY id DESC LIMIT 1`
--   must always equal `token_accounts.balance` — the audit assertion in
--   test/units.test.mjs and scripts/smoke_api.mjs both rely on that.

-- ---------------------------------------------------------------------------
-- Balances
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS token_accounts (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance            INTEGER NOT NULL DEFAULT 0,
  lifetime_purchased INTEGER NOT NULL DEFAULT 0,
  lifetime_spent     INTEGER NOT NULL DEFAULT 0,
  lifetime_earned    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (balance >= 0)
);

-- Append-only. No UPDATE or DELETE statement in src/ targets this table.
--
-- `idempotency_key` is the replay guard for every mutation path: a
-- retried purchase confirm, a double-clicked render, or a queue redelivery
-- collides on the UNIQUE index, the whole batch rolls back, and the
-- handler returns the original entry instead of moving the balance twice.
CREATE TABLE IF NOT EXISTS token_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Signed: credits are positive, debits negative. Never zero.
  delta           INTEGER NOT NULL,
  -- grant | purchase | debit | refund | earn | adjust
  kind            TEXT    NOT NULL,
  balance_after   INTEGER NOT NULL,
  -- What the entry is about: 'purchase' | 'render_job' | 'signup' | 'admin'
  ref_kind        TEXT,
  ref_id          INTEGER,
  memo            TEXT,
  idempotency_key TEXT    NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  CHECK (delta <> 0)
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_user
  ON token_ledger(user_id, id DESC);

-- ---------------------------------------------------------------------------
-- Purchases (on-chain payment, no payment processor)
-- ---------------------------------------------------------------------------
--
-- Packs are priced directly in wei rather than pegged to a fiat rate:
-- there is no oracle in this stack and an admin edit is cheaper than a
-- price feed. `price_wei` is TEXT because wei exceeds 2^53 and SQLite
-- INTEGER math would silently lose precision through the JS bridge.

CREATE TABLE IF NOT EXISTS token_packs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  title      TEXT    NOT NULL,
  tokens     INTEGER NOT NULL,
  price_wei  TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (tokens > 0)
);

-- One row per settled payment. UNIQUE(chain_id, tx_hash) is what stops
-- the same transfer being redeemed for a second pack: the confirm
-- handler verifies the receipt on-chain and then races to insert here,
-- so replaying a valid tx hash hits the constraint, not the balance.
CREATE TABLE IF NOT EXISTS token_purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id      INTEGER NOT NULL REFERENCES token_packs(id),
  chain_id     INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  from_address TEXT    NOT NULL,
  value_wei    TEXT    NOT NULL,
  tokens       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_token_purchases_user
  ON token_purchases(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Custom model registry
-- ---------------------------------------------------------------------------
--
-- A "custom model" is a creator-published render recipe: a provider
-- model plus a system prompt, a parameter schema, and a price. Coders
-- publish them, other coders render with them, and the publisher earns
-- a share of every run (see render_jobs.owner_earn_tokens).
--
-- `provider` is the execution backend, not a brand:
--   anthropic   — code generation through the Claude API
--   workers_ai  — image/texture generation through the Workers AI binding
--   mock        — deterministic canned output; dev + tests only

CREATE TABLE IF NOT EXISTS render_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT,
  -- code | image
  kind        TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  -- public | unlisted | private
  visibility  TEXT    NOT NULL DEFAULT 'private',
  -- active | disabled
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_render_models_owner
  ON render_models(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_render_models_public
  ON render_models(visibility, status, updated_at DESC);

-- Versions are immutable once written: a render job references the exact
-- version it ran against, so editing one in place would rewrite the
-- provenance of every past job. Publishing a change means inserting a
-- new version row.
CREATE TABLE IF NOT EXISTS render_model_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id          INTEGER NOT NULL REFERENCES render_models(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  -- Provider-side identifier, e.g. 'claude-opus-5' or a Workers AI model id.
  provider_model_id TEXT    NOT NULL,
  system_prompt     TEXT,
  params_schema_json TEXT,
  price_tokens      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (model_id, version),
  CHECK (price_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS idx_render_model_versions_model
  ON render_model_versions(model_id, version DESC);

-- ---------------------------------------------------------------------------
-- Render jobs
-- ---------------------------------------------------------------------------
--
-- Lifecycle: queued → running → succeeded | failed.
-- Tokens are debited at queue time (so a caller can't outrun their own
-- balance with concurrent requests) and refunded in full when the job
-- ends in `failed` — the refund is a second ledger row, never a reversal
-- of the first.
--
-- `seed` keeps the platform's determinism contract: same model version +
-- same params + same seed must reproduce the same output.

CREATE TABLE IF NOT EXISTS render_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_version_id  INTEGER NOT NULL REFERENCES render_model_versions(id),
  -- Optional: the studio project this render was made for.
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  seed              TEXT    NOT NULL,
  params_json       TEXT,
  prompt_hash       TEXT,
  status            TEXT    NOT NULL DEFAULT 'queued',
  price_tokens      INTEGER NOT NULL,
  -- Share of price_tokens credited to the model owner on success.
  owner_earn_tokens INTEGER NOT NULL DEFAULT 0,
  -- code | image
  output_kind       TEXT,
  -- Inline output for `code` jobs; R2 key for `image` jobs.
  output_text       TEXT,
  output_key        TEXT,
  output_hash       TEXT,
  error_code        TEXT,
  idempotency_key   TEXT    NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  finished_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_user
  ON render_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_render_jobs_model_version
  ON render_jobs(model_version_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
--
-- Pack prices are Base ETH amounts chosen so the cheapest pack is a
-- low-commitment trial. Edit with an UPDATE in a later migration rather
-- than in place, so price history stays auditable in git.
--   starter  500 tokens   0.001 ETH
--   studio  3000 tokens   0.005 ETH
--   pro    10000 tokens   0.015 ETH
INSERT OR IGNORE INTO token_packs (slug, title, tokens, price_wei, sort, created_at)
VALUES
  ('starter', 'Starter',  500,   '1000000000000000', 10, strftime('%s','now')),
  ('studio',  'Studio',   3000,  '5000000000000000', 20, strftime('%s','now')),
  ('pro',     'Pro',      10000, '15000000000000000', 30, strftime('%s','now'));
