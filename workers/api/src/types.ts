export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  CAPTURES?: R2Bucket;
  // Cloudflare Workers Images binding. Used by the captures resize
  // handler to transform R2 originals to allowlisted widths. When
  // unbound the handler falls back to the original PNG (dev path).
  IMAGES?: {
    input(stream: ReadableStream | ArrayBuffer): {
      transform(opts: { width?: number; height?: number; fit?: string }): {
        output(opts: { format: string; quality?: number }): Promise<{
          response(): Response;
        }>;
      };
    };
  };
  // Public IPFS gateway used to resolve frozen_cid images for OG cards.
  // Defaults to w3s.link when unset.
  IPFS_GATEWAY?: string;
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
  // --- Task #6: mint flow ---------------------------------------------------
  // Address of the deployed GAProjectFactory on the configured chain.
  // Worker only returns calldata; the user's wallet sends the tx.
  GA_FACTORY_ADDRESS?: string;
  // EIP-155 chain id; 84532 = Base Sepolia (hackathon), 8453 = Base mainnet.
  GA_CHAIN_ID?: string;
  // Public RPC URL surfaced to the client for read-only contract queries
  // (totalMinted, isCIDLocked) so we don't need a hosted indexer for
  // the hackathon demo.
  GA_RPC_URL?: string;
  // --- Task #15: Frozen artifact + provenance pipeline --------------------
  // web3.storage API token (legacy `Bearer` upload endpoint). Set via
  // `wrangler secret put W3S_TOKEN --env production`. When unset and
  // PINATA_JWT is also unset, POST /freeze returns 503
  // `pinning_unconfigured` rather than silently writing rows with a
  // CID nobody can resolve.
  W3S_TOKEN?: string;
  // Pinata API JWT. Same fail-closed semantics as W3S_TOKEN.
  PINATA_JWT?: string;
  // Mock pinning for dev / determinism tests. Opt-in only — never
  // set in production. When 1, pinBundle() reports both providers as
  // pinned without making any network calls.
  PINNING_MOCK?: string;
  // --- Task #20: Observability & error monitoring -------------------------
  // Sentry DSN for the Worker. When unset, captureException() is a
  // no-op — local dev never beacons. Set in production via:
  //   wrangler secret put SENTRY_DSN --env production
  SENTRY_DSN?: string;
  // Optional environment label included on every captured event.
  // Defaults to "production" inside captureException when omitted.
  SENTRY_ENVIRONMENT?: string;
  // Public DSN forwarded to client-side error handlers via the
  // /v1/internal/client-error route. Distinct from the worker DSN
  // so the client and worker can be sampled / quota'd separately.
  SENTRY_DSN_PUBLIC?: string;
  // Slack incoming webhook the per-minute uptime probe pages on
  // failure. When unset the probe still runs (and logs results) but
  // never posts.
  SLACK_WEBHOOK_URL?: string;
  // CSV of handles allowed to hit /v1/internal/* surfaces. Empty
  // means closed by default — the route 403s `admin_unconfigured`.
  ADMIN_HANDLES?: string;
  // Public origin the uptime probe should hit (e.g.
  // https://api.generatedart.com). When unset the probe is a no-op
  // so a misconfigured dev environment doesn't ping random hosts.
  UPTIME_PUBLIC_BASE?: string;
  // Optional third URL (typically a known public project page) the
  // probe also hits. Defaults to skipped when unset.
  UPTIME_PROJECT_PROBE_URL?: string;
}

export interface ProjectMintState {
  contract_address: string | null;
  frozen_cid: string | null;
  deploy_tx_hash: string | null;
  chain_id: number | null;
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
  last_capture_key: string | null;
  frozen_capture_key: string | null;
  contract_address: string | null;
  frozen_cid: string | null;
  deploy_tx_hash: string | null;
  chain_id: number | null;
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
  // Task #19: curator gate. 0 = regular user, 1 = verified curator
  // (can create galleries + upload gallery covers). Set manually for
  // v1; see scripts/grant_curator.sh for the helper.
  is_curator: number;
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
