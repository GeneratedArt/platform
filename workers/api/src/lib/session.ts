import { ulid } from "ulid";
import type { Env } from "./env";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = `s_${ulid()}_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.SESSIONS.put(`session:${token}`, userId, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, userId, expiresAt)
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.SESSIONS.delete(`session:${token}`);
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

export async function loadSessionUserId(
  env: Env,
  token: string
): Promise<string | null> {
  const fromKv = await env.SESSIONS.get(`session:${token}`);
  if (fromKv) return fromKv;
  const row = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?`
  )
    .bind(token, Date.now())
    .first<{ user_id: string }>();
  if (!row) return null;
  await env.SESSIONS.put(`session:${token}`, row.user_id, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return row.user_id;
}
