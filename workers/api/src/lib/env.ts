export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  ASSETS: R2Bucket;
  RENDER_QUEUE: Queue;
  PIN_QUEUE: Queue;
  ENVIRONMENT: string;
  SITE_ORIGIN: string;
  IPFS_GATEWAY: string;
  GITHUB_ORG: string;
  CHAIN_ID: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  PINATA_JWT?: string;
  STEWARD_RELAYER_PRIVATE_KEY?: string;
  ETH_RPC_URL?: string;
  FACTORY_ADDRESS?: string;
  /** Shared secret used by internal workers (github-bot, indexer) when calling
   *  privileged API endpoints. Sent as the `X-Internal-Token` header. */
  INTERNAL_BOT_TOKEN?: string;
  /** HMAC secret configured on the GitHub App webhook; used to verify the
   *  `X-Hub-Signature-256` header on every incoming webhook delivery. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Repo (within GITHUB_ORG) that hosts artist applications as Issues.
   *  Defaults to "applications". */
  APPLICATIONS_REPO?: string;
}

export type Variables = {
  userId?: string;
  sessionToken?: string;
  userRole?: string;
};
