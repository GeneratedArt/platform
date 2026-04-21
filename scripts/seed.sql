-- Demo data so the local catalog isn't empty on first run.

INSERT OR IGNORE INTO users (id, github_login, wallet_address, display_name, role, created_at)
VALUES
  ('u_demo_artist', 'demo-artist', '0x000000000000000000000000000000000000dead',
   'Demo Artist', 'artist', strftime('%s','now') * 1000),
  ('u_demo_steward', 'steward', '0x0000000000000000000000000000000000005731',
   'Steward', 'steward', strftime('%s','now') * 1000);

INSERT OR IGNORE INTO artists (user_id, slug, status, approved_at, approved_by)
VALUES ('u_demo_artist', 'demo-artist', 'approved',
        strftime('%s','now') * 1000, 'u_demo_steward');

INSERT OR IGNORE INTO projects (
  id, artist_id, slug, title, description, github_repo, license,
  edition_size, price_wei, royalty_bps, status, created_at, minted_count
) VALUES (
  'p_demo_walks', 'u_demo_artist', 'random-walks',
  'Random Walks',
  'A meditation on stochastic geometry. p5.js. 256 editions.',
  'GeneratedArt/art-random-walks', 'CC-BY-NC-4.0',
  256, '1000000000000000', 750, 'draft',
  strftime('%s','now') * 1000, 0
);

INSERT OR IGNORE INTO galleries (id, slug, name, city, country, description, physical)
VALUES ('g_geneva', 'geneva', 'GeneratedArt Geneva',
        'Geneva', 'Switzerland',
        'Physical gallery and project space at Rue François-Versonnex 17BIS.',
        1);
