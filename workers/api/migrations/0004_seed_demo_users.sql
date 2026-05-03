-- Seed two demo artists, one published project each, and a mutual
-- follow edge so a fresh dev/prod database can render `/@ga-smoke/`,
-- `/@ga-curator/`, and `/p/{id}` with non-empty data immediately
-- after running `wrangler d1 migrations apply`.
--
-- Every statement uses INSERT OR IGNORE keyed on a UNIQUE column
-- (users.address, projects.slug, follows PK) so re-applying the
-- migration is a no-op. Running this against a database that already
-- has these rows (e.g. via the static seed authors written before)
-- will not error or duplicate.
--
-- Companion static front-matter pages live at `_authors/ga-smoke.md`
-- and `_authors/ga-curator.md`; those drive the static `/@handle/`
-- layout and the dynamic D1 rows here drive the client hydration
-- (counts, follow state, project list).

INSERT OR IGNORE INTO users
  (address, handle, display_name, bio, avatar_url, socials, created_at, updated_at)
VALUES
  ('0x0000000000000000000000000000000000000001',
   'ga-smoke',
   'GA Smoke Test',
   'Demo artist seeded for Task #5 smoke tests.',
   '/assets/img/ga-mark.svg',
   '[{"label":"github","url":"https://github.com/generatedart"}]',
   strftime('%s','now'), strftime('%s','now')),
  ('0x0000000000000000000000000000000000000002',
   'ga-curator',
   'GA Curator',
   'Demo curator seeded for Task #5.',
   '/assets/img/ga-mark.svg',
   '[{"label":"github","url":"https://github.com/generatedart"}]',
   strftime('%s','now'), strftime('%s','now'));

-- Mutual follow edge so both profile pages show non-zero counts.
INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at)
  SELECT a.id, b.id, strftime('%s','now')
    FROM users a, users b
   WHERE a.handle = 'ga-smoke' AND b.handle = 'ga-curator';
INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at)
  SELECT a.id, b.id, strftime('%s','now')
    FROM users a, users b
   WHERE a.handle = 'ga-curator' AND b.handle = 'ga-smoke';

-- One published demo project per user (idempotent on slug UNIQUE).
INSERT OR IGNORE INTO projects
  (owner_id, slug, title, description, engine, license, status,
   repo_url, repo_full, cover_url, created_at, updated_at)
  SELECT u.id, 'ga-smoke-flow-fields', 'Flow Fields',
         'Demo flow-field sketch seeded for Task #5.',
         'p5js', 'MIT', 'published',
         'https://github.com/GeneratedArt-artists/ga-smoke-flow-fields',
         'GeneratedArt-artists/ga-smoke-flow-fields',
         NULL, strftime('%s','now'), strftime('%s','now')
    FROM users u WHERE u.handle = 'ga-smoke';
INSERT OR IGNORE INTO projects
  (owner_id, slug, title, description, engine, license, status,
   repo_url, repo_full, cover_url, created_at, updated_at)
  SELECT u.id, 'ga-curator-grid-study', 'Grid Study #1',
         'Demo curatorial grid study seeded for Task #5.',
         'p5js', 'MIT', 'published',
         'https://github.com/GeneratedArt-artists/ga-curator-grid-study',
         'GeneratedArt-artists/ga-curator-grid-study',
         NULL, strftime('%s','now'), strftime('%s','now')
    FROM users u WHERE u.handle = 'ga-curator';
