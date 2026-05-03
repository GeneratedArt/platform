-- Task #20: Observability & error monitoring.
--
-- Rolling per-hour counters for the activity metrics surfaced via
-- /v1/internal/stats. We deliberately avoid Cloudflare Analytics
-- Engine for v1 (no extra binding to provision, no extra billing
-- surface) and instead lean on D1 with an upsert. Each kind we care
-- about (commit / mint / freeze / request / error / route latency
-- summary) writes one row per hour and keeps a running count there.
--
-- The hour_bucket is `unix_seconds / 3600` so two writes within the
-- same wall-clock hour collide on the unique key and the upsert
-- bumps `count` instead of inserting a new row. A periodic prune
-- (older than 48h) keeps this table tiny — readStats() only ever
-- looks at the last 1h anyway.

CREATE TABLE IF NOT EXISTS metric_counters (
  kind         TEXT    NOT NULL,
  hour_bucket  INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  -- Sub-bucket: route name for per-endpoint kinds ("request",
  -- "error", "latency"); empty string ('') for global activity
  -- kinds (commit / mint / freeze). We deliberately do NOT use
  -- NULL here because SQLite treats NULL as distinct in UNIQUE
  -- constraints — every increment with route IS NULL would land
  -- as a new row instead of bumping the existing counter. Use
  -- '' as the sentinel so the PK actually de-dupes.
  route        TEXT    NOT NULL DEFAULT '',
  -- Sum + sum-of-squares for latency kinds so readStats() can do an
  -- average + a coarse p95 estimate without storing every sample.
  -- Unused for plain counters (left at 0).
  sum_ms       INTEGER NOT NULL DEFAULT 0,
  max_ms       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, hour_bucket, route)
);

-- Read path: readStats() filters by hour_bucket >= now-1h. The PK
-- above already covers (kind, hour_bucket) lookups, but most reads
-- fan out across kinds for a given hour, so an explicit index keyed
-- on hour_bucket first keeps that fast.
CREATE INDEX IF NOT EXISTS idx_metric_counters_hour
  ON metric_counters(hour_bucket DESC, kind);
