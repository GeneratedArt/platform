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
}

export type Variables = {
  userId?: string;
  sessionToken?: string;
  userRole?: string;
};
