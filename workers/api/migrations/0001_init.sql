-- GeneratedArt initial schema (D1 / SQLite).
-- Tables follow §2.2 of the platform brief.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  address     TEXT    NOT NULL UNIQUE,
  handle      TEXT    NOT NULL UNIQUE,
  bio         TEXT,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT,
  repo_url    TEXT    UNIQUE,
  cover_url   TEXT,
  status      TEXT    NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);

CREATE TABLE IF NOT EXISTS briefs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  reward      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefs_author ON briefs(author_id);
CREATE INDEX IF NOT EXISTS idx_briefs_status ON briefs(status);

CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id     INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  applicant_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  message      TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (brief_id, applicant_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_brief ON applications(brief_id);
CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);

CREATE TABLE IF NOT EXISTS galleries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT,
  curator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cover_url   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_projects (
  gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gallery_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_gallery_projects_position
  ON gallery_projects(gallery_id, position);

CREATE TABLE IF NOT EXISTS mints (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  contract_address TEXT    NOT NULL,
  chain_id         INTEGER NOT NULL,
  token_id         TEXT    NOT NULL,
  owner_address    TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL,
  minted_at        INTEGER NOT NULL,
  UNIQUE (chain_id, contract_address, token_id)
);
CREATE INDEX IF NOT EXISTS idx_mints_owner ON mints(owner_address);
CREATE INDEX IF NOT EXISTS idx_mints_project ON mints(project_id);

-- ---------------------------------------------------------------------------
-- Full-text search (FTS5) over user-facing text on users + projects + briefs.
-- The application populates this via INSERT/UPDATE triggers on the source
-- tables (added below). Search rows carry a `kind` discriminator so a single
-- query can cover all three entity types.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

-- users -> search_index
CREATE TRIGGER IF NOT EXISTS users_ai AFTER INSERT ON users BEGIN
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('user', new.id, new.handle, COALESCE(new.bio, ''));
END;
CREATE TRIGGER IF NOT EXISTS users_au AFTER UPDATE ON users BEGIN
  DELETE FROM search_index WHERE kind = 'user' AND ref_id = old.id;
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('user', new.id, new.handle, COALESCE(new.bio, ''));
END;
CREATE TRIGGER IF NOT EXISTS users_ad AFTER DELETE ON users BEGIN
  DELETE FROM search_index WHERE kind = 'user' AND ref_id = old.id;
END;

-- projects -> search_index
CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('project', new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  DELETE FROM search_index WHERE kind = 'project' AND ref_id = old.id;
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('project', new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  DELETE FROM search_index WHERE kind = 'project' AND ref_id = old.id;
END;

-- briefs -> search_index
CREATE TRIGGER IF NOT EXISTS briefs_ai AFTER INSERT ON briefs BEGIN
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('brief', new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS briefs_au AFTER UPDATE ON briefs BEGIN
  DELETE FROM search_index WHERE kind = 'brief' AND ref_id = old.id;
  INSERT INTO search_index(kind, ref_id, title, body)
  VALUES ('brief', new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS briefs_ad AFTER DELETE ON briefs BEGIN
  DELETE FROM search_index WHERE kind = 'brief' AND ref_id = old.id;
END;
