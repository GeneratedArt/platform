import type { Env } from "./env";

export async function getUserById(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT id, github_login, wallet_address, display_name, bio, avatar_r2_key, role, created_at
     FROM users WHERE id = ?`
  )
    .bind(id)
    .first();
}

export async function upsertGitHubUser(
  env: Env,
  params: {
    id: string;
    githubLogin: string;
    displayName: string | null;
    bio: string | null;
  }
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE github_login = ?`
  )
    .bind(params.githubLogin)
    .first<{ id: string }>();
  if (existing) return existing.id;
  await env.DB.prepare(
    `INSERT INTO users (id, github_login, display_name, bio, role, created_at)
     VALUES (?, ?, ?, ?, 'collector', ?)`
  )
    .bind(params.id, params.githubLogin, params.displayName, params.bio, Date.now())
    .run();
  return params.id;
}

export async function upsertWalletUser(
  env: Env,
  params: { id: string; walletAddress: string }
): Promise<string> {
  const wallet = params.walletAddress.toLowerCase();
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE wallet_address = ?`
  )
    .bind(wallet)
    .first<{ id: string }>();
  if (existing) return existing.id;
  await env.DB.prepare(
    `INSERT INTO users (id, wallet_address, role, created_at)
     VALUES (?, ?, 'collector', ?)`
  )
    .bind(params.id, wallet, Date.now())
    .run();
  return params.id;
}
