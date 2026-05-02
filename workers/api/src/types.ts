export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  JWT_SECRET: string;
  COOKIE_DOMAIN: string;
  ALLOWED_ORIGINS: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_TEMPLATE_REPO: string;
  GITHUB_MOCK: string;
}

export interface ProjectRow {
  id: number;
  owner_id: number;
  slug: string;
  title: string;
  description: string | null;
  engine: string;
  license: string;
  status: string;
  repo_url: string | null;
  repo_full: string | null;
  cover_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  id: number;
  address: string;
  handle: string;
  bio: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface JwtPayload {
  sub: string;
  uid: number;
  jti: string;
  iat: number;
  exp: number;
}
