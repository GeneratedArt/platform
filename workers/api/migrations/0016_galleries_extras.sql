-- Task #19: Galleries & curator surface.
--
-- The schema in 0001_init.sql already declares `galleries` and
-- `gallery_projects`, but no code has read or written to them. This
-- migration extends both with the columns the curator UX needs:
-- `is_curator` gate on users, markdown body + location/lat/lon + date
-- range on galleries (for physical shows), and a `created_at` on
-- `gallery_projects` so the activity feed can order "added X to
-- gallery Y" events. Reverse-lookup index (project_id) backs the
-- "Curated by" badge on the project page.

ALTER TABLE users ADD COLUMN is_curator INTEGER NOT NULL DEFAULT 0;

-- Gallery extras. body_md is the markdown description shown on the
-- public page; the existing `description` column from 0001 stays for
-- backward compatibility (we mirror title-line text into it for the
-- listing snippet). location is a freeform string ("Geneva, CH") and
-- lat/lon are optional floats — when both are present the public
-- page renders a static OSM tile; otherwise the location is shown as
-- plain text only. starts_at/ends_at are unix seconds for the
-- physical-show date range.
ALTER TABLE galleries ADD COLUMN body_md   TEXT;
ALTER TABLE galleries ADD COLUMN location  TEXT;
ALTER TABLE galleries ADD COLUMN lat       REAL;
ALTER TABLE galleries ADD COLUMN lon       REAL;
ALTER TABLE galleries ADD COLUMN starts_at INTEGER;
ALTER TABLE galleries ADD COLUMN ends_at   INTEGER;

-- When a project is added we record the timestamp so the
-- `gallery_added` event row and the gallery page can order
-- chronologically. Default 0 covers the (currently empty) backfill
-- case; new rows always set it explicitly.
ALTER TABLE gallery_projects ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

-- Curator listing index: the /v1/galleries handler filters by
-- curator_id and orders by recency; this index covers both.
CREATE INDEX IF NOT EXISTS idx_galleries_curator
  ON galleries(curator_id, created_at DESC);

-- Reverse lookup for the "Curated by" badge on /p/?id=N.
-- gallery_projects' PK is (gallery_id, project_id); project-first
-- queries weren't covered, which would table-scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_gallery_projects_project
  ON gallery_projects(project_id);
