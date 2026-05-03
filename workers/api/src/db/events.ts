import type { D1Database } from "@cloudflare/workers-types";

const DEDUPE_WINDOW_SECONDS = 30 * 60;

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
