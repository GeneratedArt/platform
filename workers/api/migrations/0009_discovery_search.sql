-- Task #16: Discovery & search surfaces.
--
-- Adds:
--   * featured_projects     — admin-curated list driving the Featured tab
--   * project_view_events   — append-only view log for the trending score
--   * search_index backfill — covers any pre-trigger seed rows (no-op if
--                             every row was inserted with the triggers
--                             from 0001 active, but cheap and idempotent)

-- Admin-curated feature list. We intentionally model this as its own
-- table (rather than a `featured` column on `projects`) so the curator
-- surface (Task #19) can write here without touching the artist's row,
-- and so we get a clean creation timestamp + sort position for free.
CREATE TABLE IF NOT EXISTS featured_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_featured_position ON featured_projects(position);

-- Append-only event log for the trending score. We deliberately store
-- raw events (not a counter) so the 7-day window is computed from
-- truth on every query and old rows can be GC'd by a cron without
-- re-deriving anything.
--
-- Privacy note: ip_hash is the SHA-256 of the visitor's IP truncated
-- to 8 bytes (16 hex chars). Enough entropy to dedupe within a window
-- but not enough to re-identify; the DB never sees the raw IP.
CREATE TABLE IF NOT EXISTS project_view_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  ip_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pve_project_ts ON project_view_events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_pve_ts ON project_view_events(ts);

-- Idempotent backfill of search_index. The 0001 triggers fire on
-- INSERT, so any seed migration that ran AFTER 0001 (e.g. 0004) is
-- already covered. This guards against a future seed/restore that
-- bypasses triggers, and against stale staging DBs created before
-- the triggers existed. INSERT OR IGNORE wouldn't help (search_index
-- has no unique key) so we DELETE + INSERT in a single statement.
DELETE FROM search_index;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'user', id, handle, COALESCE(bio, '') FROM users;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'project', id, title, COALESCE(description, '') FROM projects;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'brief', id, title, body FROM briefs;
