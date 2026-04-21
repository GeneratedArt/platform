-- Initial D1 schema for GeneratedArt.
-- Source of truth lives in workers/shared/src/schema.ts (Drizzle).
-- Apply with: wrangler d1 migrations apply generatedart --local

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  github_login    TEXT UNIQUE,
  wallet_address  TEXT UNIQUE,
  display_name    TEXT,
  bio             TEXT,
  avatar_r2_key   TEXT,
  role            TEXT NOT NULL DEFAULT 'collector',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  slug            TEXT UNIQUE NOT NULL,
  website         TEXT,
  socials_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  approved_at     INTEGER,
  approved_by     TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  artist_id        TEXT NOT NULL REFERENCES users(id),
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  github_repo      TEXT NOT NULL,
  release_tag      TEXT,
  bundle_cid       TEXT,
  license          TEXT NOT NULL DEFAULT 'CC-BY-NC-4.0',
  edition_size     INTEGER NOT NULL,
  price_wei        TEXT NOT NULL,
  royalty_bps      INTEGER NOT NULL DEFAULT 750,
  contract_address TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_at       INTEGER NOT NULL,
  minted_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_artist ON projects(artist_id);

CREATE TABLE IF NOT EXISTS editions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  token_id        INTEGER NOT NULL,
  token_hash      TEXT NOT NULL,
  owner_address   TEXT NOT NULL,
  minted_at       INTEGER NOT NULL,
  preview_r2_key  TEXT,
  metadata_cid    TEXT,
  UNIQUE(project_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_editions_owner ON editions(owner_address);
CREATE INDEX IF NOT EXISTS idx_editions_project ON editions(project_id);

CREATE TABLE IF NOT EXISTS galleries (
  id              TEXT PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  city            TEXT,
  country         TEXT,
  description     TEXT,
  steward_user_id TEXT REFERENCES users(id),
  physical        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exhibitions (
  id               TEXT PRIMARY KEY,
  gallery_id       TEXT NOT NULL REFERENCES galleries(id),
  title            TEXT NOT NULL,
  starts_at        INTEGER NOT NULL,
  ends_at          INTEGER,
  project_ids_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS physical_editions (
  edition_id      TEXT PRIMARY KEY REFERENCES editions(id),
  dongle_serial   TEXT UNIQUE,
  print_spec_json TEXT,
  shipped_to      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  subject       TEXT,
  details_json  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
