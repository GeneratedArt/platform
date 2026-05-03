-- Generative features & traits (Task #18).
--
-- Every minted token carries a flat {trait_name: trait_value} map
-- computed at mint time. We keep both representations:
--   * mints.traits_json  — denormalised JSON for fast token-detail reads.
--   * mint_traits        — normalised one-row-per-trait for filter +
--                           rarity-distribution queries on /explore and
--                           the project page traits panel.
--
-- The normalised table is the only thing the filter query touches; the
-- composite (project_id, trait_name, trait_value) index lets us answer
-- "how many tokens of project P have palette=warm?" with a single
-- index seek and no table scan.

ALTER TABLE mints ADD COLUMN traits_json TEXT;

CREATE TABLE IF NOT EXISTS mint_traits (
  mint_id     INTEGER NOT NULL REFERENCES mints(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trait_name  TEXT    NOT NULL,
  trait_value TEXT    NOT NULL,
  PRIMARY KEY (mint_id, trait_name)
);

-- Filter path: WHERE project_id = ? AND trait_name = ? AND trait_value = ?
-- Used by both the project rarity distribution and the explore filter.
CREATE INDEX IF NOT EXISTS idx_mint_traits_filter
  ON mint_traits(project_id, trait_name, trait_value);

-- Reverse lookup: "give me every trait for mint M". The PK already
-- covers (mint_id, trait_name) but we add a sole-mint index anyway so
-- a JOIN ON mint_traits.mint_id can pick it up without scanning the
-- composite from the wrong end.
CREATE INDEX IF NOT EXISTS idx_mint_traits_mint
  ON mint_traits(mint_id);
