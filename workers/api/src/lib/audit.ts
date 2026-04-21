import type { Env } from "./env";

export async function audit(
  env: Env,
  actorUserId: string | null,
  action: string,
  subject: string | null,
  details: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor_user_id, action, subject, details_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(actorUserId, action, subject, JSON.stringify(details ?? null), Date.now())
    .run();
}
