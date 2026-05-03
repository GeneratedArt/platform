-- Task #20: rolling metric counters powering /v1/internal/stats.
--
-- Granularity is per-minute so a true sliding "last 1h" window works
-- (filter `bucket_min >= now/60000 - 60`). Hour-level buckets caused
-- the read query to span up to ~120 minutes near the boundary.
--
-- `route` uses the empty-string sentinel for global activity rows
-- (commit/mint/freeze) — SQLite treats NULL as distinct in UNIQUE
-- constraints, so a NULL route would defeat the upsert.
--
-- `kind` values:
--   commit / mint / freeze         — global activity counters
--   request                         — per-route request count
--   error                           — per-route 5xx count
--   lat_h0 .. lat_h7                — per-route latency histogram
--                                     (8 fixed buckets, see metrics.ts)

CREATE TABLE IF NOT EXISTS metric_counters (
  kind         TEXT    NOT NULL,
  bucket_min   INTEGER NOT NULL,
  route        TEXT    NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, bucket_min, route)
);

CREATE INDEX IF NOT EXISTS idx_metric_counters_bucket
  ON metric_counters(bucket_min DESC, kind);
