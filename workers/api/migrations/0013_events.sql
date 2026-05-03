-- Activity feed + in-app notifications.
-- Events are append-only. Two read paths share the table:
--   * Feed:        recipient_id IS NULL, joined against follows.
--   * Notifications: recipient_id = :viewer.
-- A single row never serves both. Producers choose per kind:
--   * Notification-only (recipient_id = target user): `follow`,
--     `brief_application`, `featured`. These are private signals to
--     one user; broadcasting them would add noise to followers' feeds.
--   * Public-only (recipient_id NULL): `commit`, `freeze`, `brief_posted`.
--   * Both — two rows: `mint` writes one public-feed row plus one
--     notification to the project owner ("your project was minted").

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  actor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind   TEXT,
  target_id     INTEGER,
  recipient_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  payload_json  TEXT,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);

-- Feed query: WHERE recipient_id IS NULL AND actor_id IN (followed set)
-- ORDER BY created_at DESC, id DESC. The `recipient_id`-leading index
-- means SQLite can satisfy `IS NULL` with a single range scan and
-- avoid the public-feed rows scrolling off the end of the index when
-- the table grows. Composite tail (created_at DESC, id DESC) keeps
-- the keyset cursor monotonic across same-second inserts.
CREATE INDEX IF NOT EXISTS idx_events_recipient_created
  ON events(recipient_id, created_at DESC, id DESC);

-- Feed sub-query path: actor_id -> created_at. The follow-graph join
-- uses `actor_id IN (...)` so this is the access predicate.
CREATE INDEX IF NOT EXISTS idx_events_actor_created
  ON events(actor_id, created_at DESC, id DESC);

-- Unread badge: COUNT(*) WHERE recipient_id = me AND read_at IS NULL.
-- Partial index keeps it tiny — only unread rows live here, so the
-- count never scans the whole table even if the user has 10k history.
CREATE INDEX IF NOT EXISTS idx_events_unread
  ON events(recipient_id, id) WHERE read_at IS NULL;
