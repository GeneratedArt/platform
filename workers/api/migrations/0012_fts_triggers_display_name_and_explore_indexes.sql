-- Keep user FTS rows in sync with display_name (the 0001 triggers only
-- indexed handle + bio), and add composite indexes that back the
-- /explore Recent and Trending lookups.

DROP TRIGGER IF EXISTS users_ai;
DROP TRIGGER IF EXISTS users_au;

CREATE TRIGGER users_ai AFTER INSERT ON users BEGIN
  INSERT INTO search_index(kind, ref_id, title, body)
    VALUES ('user', new.id, new.handle,
            TRIM(COALESCE(new.display_name, '') || ' ' || COALESCE(new.bio, '')));
END;

CREATE TRIGGER users_au AFTER UPDATE ON users BEGIN
  DELETE FROM search_index WHERE kind = 'user' AND ref_id = old.id;
  INSERT INTO search_index(kind, ref_id, title, body)
    VALUES ('user', new.id, new.handle,
            TRIM(COALESCE(new.display_name, '') || ' ' || COALESCE(new.bio, '')));
END;

-- Recent tab on /explore filters by status IN ('published','minted')
-- and orders by (created_at DESC, id DESC). Composite index covers
-- both the filter and the keyset cursor.
CREATE INDEX IF NOT EXISTS idx_projects_status_created
  ON projects(status, created_at DESC, id DESC);

-- Trending joins projects against project_view_events; an index on
-- (project_id, ts) is already in 0009 (idx_pve_project_ts) so the
-- per-project rollup is cheap. Add an updated_at index for Featured
-- tie-breaking.
CREATE INDEX IF NOT EXISTS idx_projects_updated
  ON projects(updated_at DESC);
