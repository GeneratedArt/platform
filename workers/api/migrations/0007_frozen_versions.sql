-- Task #15: Frozen artifact + provenance pipeline.
--
-- Each row is one immutable, content-addressed bundle of a project at
-- a specific commit. The bundler builds a self-contained HTML +
-- SHA-256 hash of the canonical bundle bytes; the pinner fans out to
-- web3.storage + Pinata and writes the CID returned by the (first)
-- successful provider. The active row's CID is what the on-chain
-- `setBaseFrozenCID` call locks into the project contract.
--
-- A project may have many frozen_versions over time (e.g. the artist
-- iterates on the sketch and re-freezes); only one is_active=1 at a
-- time, enforced by the partial unique index below.

CREATE TABLE IF NOT EXISTS frozen_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Source commit. May be a 40-char SHA, "latest", or "mock-<hash>"
  -- for mock-mode runs that don't hit the GitHub API.
  commit_sha      TEXT    NOT NULL,
  -- Provider-returned CID (web3.storage or Pinata). Falls back to a
  -- locally-computed CIDv1-raw of the bundle bytes when neither
  -- provider is configured (clearly flagged via pinning_partial).
  cid             TEXT    NOT NULL,
  -- SHA-256 of the canonical bundle bytes, lowercase hex. Deterministic
  -- for identical inputs; this is the value the contract-side hash
  -- check will compare against once on-chain provenance ships.
  bundle_hash     TEXT    NOT NULL,
  -- Bundle size in bytes (post-canonicalisation, pre-pin).
  bytes           INTEGER NOT NULL,
  -- Per-provider pinning state. 0 = not pinned (or failed), 1 = pinned.
  pinned_w3s      INTEGER NOT NULL DEFAULT 0,
  pinned_pinata   INTEGER NOT NULL DEFAULT 0,
  -- pinning_partial = 1 when at least one provider succeeded but not
  -- all of them. Surface a "retry" affordance in the UI.
  pinning_partial INTEGER NOT NULL DEFAULT 0,
  -- Free-form provider-error JSON for the UI to show "what failed".
  pin_errors      TEXT,
  -- Active version pointer. Exactly one row per project may have
  -- is_active=1 (enforced by the partial unique index below).
  is_active       INTEGER NOT NULL DEFAULT 0,
  -- Last drift-check timestamp (nightly cron updates this).
  last_checked_at INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frozen_versions_project
  ON frozen_versions(project_id, created_at DESC);

-- Enforce "at most one active version per project". Partial index
-- works in SQLite/D1 and avoids races where two activations could
-- otherwise both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_frozen_versions_active_unique
  ON frozen_versions(project_id) WHERE is_active = 1;

-- Re-query by CID for cron drift checks.
CREATE INDEX IF NOT EXISTS idx_frozen_versions_cid
  ON frozen_versions(cid);
