export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  JWT_SECRET: string;
  COOKIE_DOMAIN: string;
  ALLOWED_ORIGINS: string;
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
