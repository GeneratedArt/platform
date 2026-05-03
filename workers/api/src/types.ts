export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  CAPTURES?: R2Bucket;
  JWT_SECRET: string;
  COOKIE_DOMAIN: string;
  ALLOWED_ORIGINS: string;
  GITHUB_PAT: string;
  GITHUB_ORG: string;
  GITHUB_TEMPLATE_REPO: string;
  GITHUB_MOCK: string;
  CAPTURES_PUBLIC_BASE?: string;
  // Repo (owner/name) the platform commits author profile MDs into.
  // When unset in non-mock mode, PATCH /v1/me still updates D1 but
  // the GitHub mirror commit is skipped (best-effort) and the
  // response advertises that the static page won't update until a
  // human commits the file.
  GITHUB_SITE_REPO?: string;
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
  display_name: string | null;
  socials: string | null;     // JSON-encoded array of {label,url}
  cover_image: string | null;
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
