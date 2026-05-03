-- Discovery & search follow-on:
--
-- 1. projects.frozen_capture_key — the R2 key of the canonical
--    capture associated with the project's currently-active
--    frozen_version. The frozen bundle CID points at the HTML/JS
--    artifact, not an image, so social crawlers can't render that as
--    og:image. We snapshot last_capture_key into frozen_capture_key
--    when a frozen version is activated and use that as the OG card
--    source for minted/frozen projects.
--
-- 2. Rebuild search_index with display_name folded into the user
--    body so artist search matches on display names too (not just
--    handle/bio).

ALTER TABLE projects ADD COLUMN frozen_capture_key TEXT;

DELETE FROM search_index;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'user', id, handle,
         TRIM(COALESCE(display_name, '') || ' ' || COALESCE(bio, ''))
  FROM users;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'project', id, title, COALESCE(description, '') FROM projects;
INSERT INTO search_index(kind, ref_id, title, body)
  SELECT 'brief', id, title, body FROM briefs;
