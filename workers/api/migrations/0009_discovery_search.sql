-- Discovery & search: featured list + view events + FTS backfill.

CREATE TABLE IF NOT EXISTS featured_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_featured_position ON featured_projects(position);

CREATE TABLE IF NOT EXISTS project_view_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  ip_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pve_project_ts ON project_view_events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_pve_ts ON project_view_events(ts);

-- Idempotent FTS backfill (covers any seed/restore that bypassed the 0001 triggers).
DELETE FROM search_index;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'user', id, handle, COALESCE(bio, '') FROM users;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'project', id, title, COALESCE(description, '') FROM projects;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'brief', id, title, body FROM briefs;
