// Append-only project_view_events log. Drives the trending score on
// /v1/explore?tab=trending. We dedupe within a 30-minute window per
// (project, ip_hash) so refreshing a tab doesn't artificially inflate
// the count, and so a single bot loop can't dominate the ranking.

import type { D1Database } from "@cloudflare/workers-types";

const DEDUPE_WINDOW_SECONDS = 30 * 60;

/// Hash an IP into 8 bytes (16 hex chars). Enough entropy to dedupe
/// within a window but not enough to re-identify the visitor in
/// isolation. We also salt with project_id so the same IP viewing
/// two projects doesn't share a hash key.
async function hashIp(projectId: number, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${projectId}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export async function recordProjectView(
  db: D1Database,
  projectId: number,
  ip: string,
): Promise<void> {
  const ipHash = await hashIp(projectId, ip);
  const now = Math.floor(Date.now() / 1000);
  // Dedupe inside the window. A small race here (two concurrent
  // requests from the same IP both passing the SELECT) is acceptable:
  // worst case we double-count once, which barely moves the trend
  // score. Avoiding a unique constraint keeps the write path a
  // single statement on the happy path.
  const recent = await db
    .prepare(
      `SELECT 1 FROM project_view_events
       WHERE project_id = ? AND ip_hash = ? AND ts >= ?
       LIMIT 1`,
    )
    .bind(projectId, ipHash, now - DEDUPE_WINDOW_SECONDS)
    .first();
  if (recent) return;
  await db
    .prepare(
      `INSERT INTO project_view_events (project_id, ts, ip_hash)
       VALUES (?, ?, ?)`,
    )
    .bind(projectId, now, ipHash)
    .run();
}

/// GC entries older than the trending window. Called from the
/// nightly cron to keep the table from growing unbounded.
export async function pruneOldViewEvents(
  db: D1Database,
  olderThanSeconds: number = 30 * 24 * 3600,
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  await db
    .prepare(`DELETE FROM project_view_events WHERE ts < ?`)
    .bind(cutoff)
    .run();
}
