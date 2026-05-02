-- Adds the columns we discovered we need only after wiring the
-- Repo-as-Project flow: which engine the project ships with, which
-- license the artist picked at create time, and the canonical
-- "owner/repo" GitHub identifier (in addition to the human-facing repo_url).
-- Status values used by the app: 'draft' | 'published' | 'minted' | 'archived'.

-- SQLite forbids adding a UNIQUE column via ALTER TABLE, so repo_full is added
-- as a plain column and uniqueness is enforced through a unique index instead.
ALTER TABLE projects ADD COLUMN engine    TEXT NOT NULL DEFAULT 'p5';
ALTER TABLE projects ADD COLUMN license   TEXT NOT NULL DEFAULT 'CC-BY-NC-4.0';
ALTER TABLE projects ADD COLUMN repo_full TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repo_full ON projects(repo_full);
