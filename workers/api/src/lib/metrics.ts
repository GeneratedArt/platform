// Task #20: D1-backed rolling metric counters.
//
// Three counter families:
//   * activity counters  — kind in {"commit","mint","freeze"}; a
//     simple +1 per success. Used for the activity-drop alerts the
//     task brief calls out (commits_per_hour etc).
//   * request counters   — kind in {"request","error"}; written by
//     the per-request access middleware; broken down by route.
//   * latency counters   — kind = "latency"; carries sum_ms and
//     max_ms so readStats() can produce avg + p95-ish numbers
//     without per-sample storage.
//
// Reads only ever look at the last 1h of buckets, so the table
// stays small. A nightly prune (in the existing scheduled handler)
// drops anything older than 48h.

import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../types";

export type ActivityKind = "commit" | "mint" | "freeze";
export type RequestKind = "request" | "error";

export function hourBucket(now: number = Date.now()): number {
  return Math.floor(now / 1000 / 3600);
}

/**
 * Increment an activity counter (commits/mints/freezes). Caller is
 * expected to wrap this in `ctx.waitUntil()` so a counter write
 * never blocks the user-facing response.
 */
// Sentinel for activity counters — see note in metric_counters
// schema. SQLite treats NULL as distinct in UNIQUE constraints, so
// `ON CONFLICT(kind,hour_bucket,route)` would never match if we
// stored NULL here and every increment would land as a new row.
// Empty string is reserved for the "global / no route" bucket.
const NO_ROUTE = "";

export async function bumpActivity(db: D1Database, kind: ActivityKind): Promise<void> {
  const bucket = hourBucket();
  await db
    .prepare(
      `INSERT INTO metric_counters (kind, hour_bucket, route, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(kind, hour_bucket, route) DO UPDATE SET count = count + 1`,
    )
    .bind(kind, bucket, NO_ROUTE)
    .run();
}

/**
 * Per-request increment with route + latency. Called from the
 * access-log middleware after the response status is known.
 */
export async function bumpRequest(
  db: D1Database,
  args: {
    route: string;
    status: number;
    latency_ms: number;
  },
): Promise<void> {
  const bucket = hourBucket();
  const route = sanitizeRoute(args.route);
  const ms = Math.max(0, Math.min(60_000, Math.round(args.latency_ms)));

  // Single-statement BATCH so the three rows land or fail together;
  // a partial write would skew error_rate readings.
  const stmts = [
    db
      .prepare(
        `INSERT INTO metric_counters (kind, hour_bucket, route, count)
         VALUES ('request', ?, ?, 1)
         ON CONFLICT(kind, hour_bucket, route) DO UPDATE SET count = count + 1`,
      )
      .bind(bucket, route),
    db
      .prepare(
        `INSERT INTO metric_counters (kind, hour_bucket, route, count, sum_ms, max_ms)
         VALUES ('latency', ?, ?, 1, ?, ?)
         ON CONFLICT(kind, hour_bucket, route) DO UPDATE
           SET count = count + 1,
               sum_ms = sum_ms + excluded.sum_ms,
               max_ms = MAX(max_ms, excluded.max_ms)`,
      )
      .bind(bucket, route, ms, ms),
  ];
  if (args.status >= 500) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO metric_counters (kind, hour_bucket, route, count)
           VALUES ('error', ?, ?, 1)
           ON CONFLICT(kind, hour_bucket, route) DO UPDATE SET count = count + 1`,
        )
        .bind(bucket, route),
    );
  }
  await db.batch(stmts);
}

export interface StatsSnapshot {
  hour_bucket: number;
  commits_per_hour: number;
  mints_per_hour: number;
  freezes_per_hour: number;
  request_count_1h: number;
  error_count_1h: number;
  error_rate: number;
  by_route: Array<{
    route: string;
    requests: number;
    errors: number;
    avg_ms: number;
    max_ms: number;
  }>;
}

export async function readStats(db: D1Database): Promise<StatsSnapshot> {
  const bucket = hourBucket();
  // 1h cutoff. Two buckets are queried so reads near a bucket boundary
  // see a contiguous window.
  const minBucket = bucket - 1;

  const [counters, perRoute] = await Promise.all([
    db
      .prepare(
        `SELECT kind, SUM(count) AS n
           FROM metric_counters
          WHERE hour_bucket >= ?
            AND kind IN ('commit','mint','freeze','request','error')
          GROUP BY kind`,
      )
      .bind(minBucket)
      .all<{ kind: string; n: number }>(),
    db
      .prepare(
        `SELECT route,
                COALESCE(SUM(CASE WHEN kind='request' THEN count END), 0) AS requests,
                COALESCE(SUM(CASE WHEN kind='error'   THEN count END), 0) AS errors,
                COALESCE(SUM(CASE WHEN kind='latency' THEN sum_ms END), 0) AS sum_ms,
                COALESCE(SUM(CASE WHEN kind='latency' THEN count  END), 0) AS samples,
                COALESCE(MAX(CASE WHEN kind='latency' THEN max_ms END), 0) AS max_ms
           FROM metric_counters
          WHERE hour_bucket >= ?
            AND route IS NOT NULL
            AND route != ''
          GROUP BY route
          ORDER BY requests DESC
          LIMIT 50`,
      )
      .bind(minBucket)
      .all<{
        route: string;
        requests: number;
        errors: number;
        sum_ms: number;
        samples: number;
        max_ms: number;
      }>(),
  ]);

  const byKind = new Map<string, number>();
  for (const r of counters.results ?? []) byKind.set(r.kind, r.n);
  const requests = byKind.get("request") ?? 0;
  const errors = byKind.get("error") ?? 0;

  return {
    hour_bucket: bucket,
    commits_per_hour: byKind.get("commit") ?? 0,
    mints_per_hour: byKind.get("mint") ?? 0,
    freezes_per_hour: byKind.get("freeze") ?? 0,
    request_count_1h: requests,
    error_count_1h: errors,
    error_rate: requests > 0 ? +(errors / requests).toFixed(4) : 0,
    by_route: (perRoute.results ?? []).map((r) => ({
      route: r.route,
      requests: r.requests,
      errors: r.errors,
      avg_ms: r.samples > 0 ? Math.round(r.sum_ms / r.samples) : 0,
      max_ms: r.max_ms,
    })),
  };
}

/**
 * Best-effort wrapper for activity increments: swallows any error
 * and emits a warn line so a counter outage never breaks user flow.
 * Intended for `ctx.waitUntil(safeBump(...))` from handlers.
 */
export async function safeBumpActivity(
  env: Env,
  kind: ActivityKind,
): Promise<void> {
  try {
    await bumpActivity(env.DB, kind);
  } catch (err) {
    console.warn(`metric_bump_failed kind=${kind}: ${(err as Error).message}`);
  }
}

export async function safeBumpRequest(
  env: Env,
  args: { route: string; status: number; latency_ms: number },
): Promise<void> {
  try {
    await bumpRequest(env.DB, args);
  } catch (err) {
    console.warn(`metric_bump_request_failed: ${(err as Error).message}`);
  }
}

/** Drop counter rows older than 48h. Called from the daily cron. */
export async function pruneOldMetrics(db: D1Database): Promise<void> {
  const cutoff = hourBucket() - 48;
  await db
    .prepare(`DELETE FROM metric_counters WHERE hour_bucket < ?`)
    .bind(cutoff)
    .run();
}

const ROUTE_ALLOWED = /^[a-z0-9_:./-]+$/i;

function sanitizeRoute(route: string): string {
  // The middleware passes the matched Hono path (e.g. "/v1/projects/:id/commit").
  // Belt-and-braces: clip at 120 chars and refuse anything weird so a
  // crafted URL can't smuggle SQL or 1MB of garbage into the table.
  const clipped = route.slice(0, 120);
  return ROUTE_ALLOWED.test(clipped) ? clipped : "_invalid";
}
