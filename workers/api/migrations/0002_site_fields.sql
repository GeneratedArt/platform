-- Additive columns the public site needs beyond the §5 minimum schema.
-- All nullable / defaulted so existing rows are unaffected.

ALTER TABLE users      ADD COLUMN location   TEXT;
ALTER TABLE users      ADD COLUMN avatar_url TEXT;

ALTER TABLE projects   ADD COLUMN tagline    TEXT;
ALTER TABLE projects   ADD COLUMN starts_at  INTEGER;

ALTER TABLE galleries  ADD COLUMN address    TEXT;
ALTER TABLE galleries  ADD COLUMN website    TEXT;
ALTER TABLE galleries  ADD COLUMN tagline    TEXT;
ALTER TABLE galleries  ADD COLUMN featured   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE galleries  ADD COLUMN active     INTEGER NOT NULL DEFAULT 1;
