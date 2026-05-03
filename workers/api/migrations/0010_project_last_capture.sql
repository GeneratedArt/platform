-- Track the most recent R2 capture key per project so /v1/explore and
-- /v1/og/projects/:id can build a thumbnail URL without doing an R2
-- list per row.
ALTER TABLE projects ADD COLUMN last_capture_key TEXT;
