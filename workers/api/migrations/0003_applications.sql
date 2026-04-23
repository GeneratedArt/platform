-- Artist applications submitted via /apply. One row per submission; the
-- GitHub Issue in GeneratedArt/applications is the human-facing record and
-- the curator workflow surface. We mirror status here so the API can answer
-- "where is my application?" without hitting GitHub on every page load.
CREATE TABLE IF NOT EXISTS applications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_slug     TEXT NOT NULL,
  bio             TEXT NOT NULL,
  portfolio_links TEXT NOT NULL,                       -- JSON array of URLs
  wallet_address  TEXT,
  github_issue    INTEGER,                             -- issue number in applications repo
  github_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|withdrawn
  reviewed_by     TEXT REFERENCES users(id),
  reviewed_at     INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (user_id, status)                             -- one open application at a time
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_issue  ON applications(github_issue);
