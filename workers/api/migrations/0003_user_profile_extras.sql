-- Task #5 — Profile, portfolio & follow.
--
-- The base `users` row from 0001_init only carries the bits that SIWE itself
-- needs to mint a session: address + handle + bio + avatar_url. The profile
-- page wants more: a human display name (handle is a slug, not a name), a
-- structured list of socials, and an optional banner. We store socials as a
-- JSON-encoded TEXT blob because SQLite has no native JSON type and a
-- relational `user_socials` table buys nothing for the read pattern (the
-- profile page always wants the whole list at once).
--
-- All fields are NULLable so existing rows (the smoke + curator seeds, plus
-- any wallet that has signed in but never opened the editor) stay valid
-- without a backfill.

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN socials      TEXT;  -- JSON: [{"label":"twitter","url":"https://…"}]
ALTER TABLE users ADD COLUMN cover_image  TEXT;
