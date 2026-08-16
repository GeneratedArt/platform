// Per-minute rolling counters for /v1/internal/stats.
//
// Three counter families share one table:
//   * activity (commit/mint/freeze)  — global, route=''
//   * request / error                — per route
//   * latency histogram              — kind=lat_h{0..7}, per route
//
// readStats() filters strictly to the last 60 minutes via bucket_min.

import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../types";

export type ActivityKind = "commit" | "mint" | "freeze";

const NO_ROUTE = "";

// Histogram boundaries in ms. 8 buckets total; the last is open-ended.
// Keep this stable — readStats() relies on the index/edge alignment.
const LATENCY_EDGES = [50, 100, 250, 500, 1000, 2500, 5000];

export function minuteBucket(now: number = Date.now()): number {
  return Math.floor(now / 60_000);
}

function latencyBucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_EDGES.length; i++) {
    if (ms < LATENCY_EDGES[i]) return i;
  }
  return LATENCY_EDGES.length;
}

export async function bumpActivity(db: D1Database, kind: ActivityKind): Promise<void> {
  await db
    .prepare(
      `INSERT INTO metric_counters (kind, bucket_min, route, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(kind, bucket_min, route) DO UPDATE SET count = count + 1`,
    )
    .bind(kind, minuteBucket(), NO_ROUTE)
    .run();
}

export async function bumpRequest(
  db: D1Database,
  args: { route: string; status: number; latency_ms: number },
): Promise<void> {
  const bucket = minuteBucket();
  const route = sanitizeRoute(args.route);
  const ms = Math.max(0, Math.min(60_000, Math.round(args.latency_ms)));
  const histKind = `lat_h${latencyBucketIndex(ms)}`;

  const stmts = [
    db
      .prepare(
        `INSERT INTO metric_counters (kind, bucket_min, route, count)
         VALUES ('request', ?, ?, 1)
         ON CONFLICT(kind, bucket_min, route) DO UPDATE SET count = count + 1`,
      )
      .bind(bucket, route),
    db
      .prepare(
        `INSERT INTO metric_counters (kind, bucket_min, route, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(kind, bucket_min, route) DO UPDATE SET count = count + 1`,
      )
      .bind(histKind, bucket, route),
  ];
  if (args.status >= 500) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO metric_counters (kind, bucket_min, route, count)
           VALUES ('error', ?, ?, 1)
           ON CONFLICT(kind, bucket_min, route) DO UPDATE SET count = count + 1`,
        )
        .bind(bucket, route),
    );
  }
  await db.batch(stmts);
}

export interface RouteRow {
  route: string;
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
}

export interface StatsSnapshot {
  window_min: number;
  commits_per_hour: number;
  mints_per_hour: number;
  freezes_per_hour: number;
  request_count_1h: number;
  error_count_1h: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  by_route: RouteRow[];
}

export async function readStats(db: D1Database): Promise<StatsSnapshot> {
  const now = minuteBucket();
  const windowMin = 60;
  const minBucket = now - windowMin + 1; // strict last 60 minutes

  // Single fan-out read: pull every row in the window, aggregate in JS.
  // The window holds <= ~3000 rows (60 min × ~50 routes × few kinds).
  const rs = await db
    .prepare(
      `SELECT kind, route, count
         FROM metric_counters
        WHERE bucket_min >= ?`,
    )
    .bind(minBucket)
    .all<{ kind: string; route: string; count: number }>();

  const totals: Record<string, number> = {
    commit: 0,
    mint: 0,
    freeze: 0,
    request: 0,
    error: 0,
  };
  // route -> { requests, errors, hist[8] }
  const perRoute = new Map<
    string,
    { requests: number; errors: number; hist: number[] }
  >();
  // global histogram
  const globalHist = new Array<number>(LATENCY_EDGES.length + 1).fill(0);

  for (const row of rs.results ?? []) {
    if (row.kind in totals) totals[row.kind] += row.count;
    const isHist = row.kind.startsWith("lat_h");
    const isReq = row.kind === "request";
    const isErr = row.kind === "error";
    if (!isHist && !isReq && !isErr) continue;
    if (!row.route) continue;
    let agg = perRoute.get(row.route);
    if (!agg) {
      agg = { requests: 0, errors: 0, hist: new Array(LATENCY_EDGES.length + 1).fill(0) };
      perRoute.set(row.route, agg);
    }
    if (isReq) agg.requests += row.count;
    else if (isErr) agg.errors += row.count;
    else if (isHist) {
      const idx = parseInt(row.kind.slice("lat_h".length), 10);
      if (idx >= 0 && idx <= LATENCY_EDGES.length) {
        agg.hist[idx] += row.count;
        globalHist[idx] += row.count;
      }
    }
  }

  const byRoute: RouteRow[] = [];
  for (const [route, agg] of perRoute) {
    byRoute.push({
      route,
      requests: agg.requests,
      errors: agg.errors,
      error_rate: agg.requests > 0 ? +(agg.errors / agg.requests).toFixed(4) : 0,
      p50_ms: histPercentile(agg.hist, 0.5),
      p95_ms: histPercentile(agg.hist, 0.95),
    });
  }
  byRoute.sort((a, b) => b.requests - a.requests);

  return {
    window_min: windowMin,
    commits_per_hour: totals.commit,
    mints_per_hour: totals.mint,
    freezes_per_hour: totals.freeze,
    request_count_1h: totals.request,
    error_count_1h: totals.error,
    error_rate: totals.request > 0 ? +(totals.error / totals.request).toFixed(4) : 0,
    p50_ms: histPercentile(globalHist, 0.5),
    p95_ms: histPercentile(globalHist, 0.95),
    by_route: byRoute.slice(0, 50),
  };
}

function histPercentile(hist: number[], q: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const target = Math.ceil(total * q);
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i];
    if (cum >= target) {
      // Report the upper edge of the bucket; final (open) bucket
      // reports its lower edge as a conservative estimate.
      return i < LATENCY_EDGES.length ? LATENCY_EDGES[i] : LATENCY_EDGES[LATENCY_EDGES.length - 1];
    }
  }
  return LATENCY_EDGES[LATENCY_EDGES.length - 1];
}

export async function safeBumpActivity(env: Env, kind: ActivityKind): Promise<void> {
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

/** Drop counter rows older than 24h. Called from the daily cron. */
export async function pruneOldMetrics(db: D1Database): Promise<void> {
  const cutoff = minuteBucket() - 24 * 60;
  await db
    .prepare(`DELETE FROM metric_counters WHERE bucket_min < ?`)
    .bind(cutoff)
    .run();
}

const ROUTE_ALLOWED = /^[a-z0-9_:./-]+$/i;

export function sanitizeRoute(route: string): string {
  // Hono's `routePath` echoes the registered pattern *including* any
  // inline regex constraint — `/v1/projects/:id{[0-9]+}`. Those braces
  // and brackets fail ROUTE_ALLOWED, which used to collapse every
  // parameterised route (projects, mint, freeze, galleries, captures —
  // i.e. the whole core of the API) into a single `_invalid` bucket in
  // /v1/internal/stats. Strip the constraint and keep the readable
  // `/v1/projects/:id` label; the allowlist then only has to guard
  // against a genuinely unexpected path.
  const normalised = route.replace(/\{[^}]*\}/g, "");
  const clipped = normalised.slice(0, 120);
  return ROUTE_ALLOWED.test(clipped) ? clipped : "_invalid";
}
