-- Task #7 — Briefs board (read + post).
--
-- The base `briefs` row from 0001_init carries id/author_id/title/body/reward/
-- status/created_at/updated_at. The board layered on top of it needs three
-- extra fields surfaced in the spec:
--   * industry  — required, drives the URL filter (?industry=textile etc).
--                 Stored as TEXT with an app-level allowlist so we can extend
--                 without a schema change. Existing rows (none in prod yet,
--                 just demo seeds if any) get the safe `other` fallback.
--   * budget    — optional, free-form ETH amount string ("0.5", "1.25").
--                 We keep it TEXT instead of NUMERIC because (a) ETH values
--                 may exceed JS-number precision and (b) we never do
--                 arithmetic on it server-side; the wallet handles that.
--                 The legacy `reward` column from 0001 is left untouched
--                 (we keep it nullable and unused) so future application/
--                 escrow code can repurpose it without another migration.
--   * deadline  — optional unix-seconds timestamp. INTEGER for cheap
--                 ORDER BY / range filters when we later add a "closing
--                 soon" view.

ALTER TABLE briefs ADD COLUMN industry TEXT NOT NULL DEFAULT 'other';
ALTER TABLE briefs ADD COLUMN budget   TEXT;
ALTER TABLE briefs ADD COLUMN deadline INTEGER;

CREATE INDEX IF NOT EXISTS idx_briefs_industry ON briefs(industry);
CREATE INDEX IF NOT EXISTS idx_briefs_created  ON briefs(created_at);
