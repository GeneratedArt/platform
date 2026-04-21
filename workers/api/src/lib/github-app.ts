import type { Env } from "./env";

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function makeAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("github_app_not_configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID })
  );
  const data = `${header}.${payload}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );
  return `${data}.${base64UrlEncode(sig)}`;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getInstallationToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }
  if (!env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error("github_app_installation_not_configured");
  }
  const jwt = await makeAppJwt(env);
  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "GeneratedArt-API",
      },
    }
  );
  if (!res.ok)
    throw new Error(`github_installation_token_failed:${res.status}:${await res.text()}`);
  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  return data.token;
}

export interface CreatedRepo {
  full_name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
}

export async function createArtRepo(
  env: Env,
  slug: string,
  description: string
): Promise<CreatedRepo> {
  const token = await getInstallationToken(env);
  const res = await fetch(`https://api.github.com/orgs/${env.GITHUB_ORG}/repos`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "GeneratedArt-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `art-${slug}`,
      description: description.slice(0, 350),
      private: false,
      auto_init: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`github_repo_create_failed:${res.status}:${await res.text()}`);
  }
  const data = (await res.json()) as CreatedRepo;
  return data;
}
