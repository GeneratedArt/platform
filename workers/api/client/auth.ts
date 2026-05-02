import {
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type EIP1193Provider,
} from "viem";
import { mainnet } from "viem/chains";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    GAAuth?: typeof GAAuth;
  }
}

interface AuthConfig {
  apiBase: string;
  domain: string;
  origin: string;
  statement: string;
  chainId: number;
}

interface MeResponse {
  user: {
    id: number;
    address: string;
    handle: string;
    bio: string | null;
    avatar_url: string | null;
  };
}

const DEFAULTS: AuthConfig = {
  apiBase: "http://localhost:8787",
  domain: window.location.host,
  origin: window.location.origin,
  statement: "Sign in to GeneratedArt.",
  chainId: 1,
};

function buildSiweMessage(opts: {
  domain: string;
  address: Address;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    "",
    opts.statement,
    "",
    `URI: ${opts.uri}`,
    `Version: 1`,
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ].join("\n");
}

async function fetchNonce(apiBase: string): Promise<string> {
  const res = await fetch(`${apiBase}/v1/auth/siwe/nonce`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`nonce_request_failed: ${res.status}`);
  }
  const body = (await res.json()) as { nonce: string };
  return body.nonce;
}

async function postVerify(
  apiBase: string,
  message: string,
  signature: string,
): Promise<MeResponse> {
  const res = await fetch(`${apiBase}/v1/auth/siwe/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`verify_failed: ${res.status} ${text}`);
  }
  return (await res.json()) as MeResponse;
}

async function fetchMe(apiBase: string): Promise<MeResponse | null> {
  const res = await fetch(`${apiBase}/v1/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me_failed: ${res.status}`);
  return (await res.json()) as MeResponse;
}

async function logout(apiBase: string): Promise<void> {
  await fetch(`${apiBase}/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

async function signInWithEthereum(cfg: AuthConfig): Promise<MeResponse> {
  if (!window.ethereum) {
    throw new Error("no_wallet_detected");
  }
  const provider = window.ethereum;
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as Address[];
  if (!accounts?.length) {
    throw new Error("no_account_authorised");
  }
  const address = getAddress(accounts[0]);
  const wallet = createWalletClient({
    account: address,
    chain: mainnet,
    transport: custom(provider),
  });

  const nonce = await fetchNonce(cfg.apiBase);
  const message = buildSiweMessage({
    domain: cfg.domain,
    address,
    statement: cfg.statement,
    uri: cfg.origin,
    chainId: cfg.chainId,
    nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await wallet.signMessage({
    account: address,
    message,
  });
  return postVerify(cfg.apiBase, message, signature);
}

const GAAuth = {
  async connect(overrides: Partial<AuthConfig> = {}): Promise<MeResponse> {
    const cfg = { ...DEFAULTS, ...overrides };
    return signInWithEthereum(cfg);
  },
  async me(apiBase: string = DEFAULTS.apiBase): Promise<MeResponse | null> {
    return fetchMe(apiBase);
  },
  async logout(apiBase: string = DEFAULTS.apiBase): Promise<void> {
    return logout(apiBase);
  },
};

window.GAAuth = GAAuth;
export default GAAuth;
