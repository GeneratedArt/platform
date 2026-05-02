import type { Env } from "../types";

const GITHUB_API = "https://api.github.com";

export interface GeneratedRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export class GitHubError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function ghHeaders(pat: string): HeadersInit {
  return {
    "Authorization": `Bearer ${pat}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "generatedart-api",
    "Content-Type": "application/json",
  };
}

function isMockMode(env: Env): boolean {
  // Mock mode is OPT-IN only via GITHUB_MOCK=1. A missing PAT must NOT
  // silently fall back to mock mode, otherwise a production
  // misconfiguration would silently "succeed" project creation and
  // write D1 rows pointing to non-existent repos. Missing PAT in
  // non-mock mode raises a clean 503.
  return env.GITHUB_MOCK === "1";
}

export async function generateRepoFromTemplate(
  env: Env,
  args: { repoName: string; description: string; private: boolean },
): Promise<GeneratedRepo> {
  if (isMockMode(env)) {
    const owner = env.GITHUB_ORG || "GeneratedArt-artists";
    return {
      full_name: `${owner}/${args.repoName}`,
      html_url: `https://github.com/${owner}/${args.repoName}`,
      default_branch: "main",
    };
  }

  if (!env.GITHUB_PAT) {
    throw new GitHubError(
      "github_pat_unconfigured",
      503,
      "GITHUB_PAT secret must be set in production (use `wrangler secret put GITHUB_PAT --env production`).",
    );
  }
  if (!env.GITHUB_TEMPLATE_REPO || !env.GITHUB_ORG) {
    throw new GitHubError(
      "github_template_unconfigured",
      503,
      "GITHUB_TEMPLATE_REPO and GITHUB_ORG must be set",
    );
  }

  const url = `${GITHUB_API}/repos/${env.GITHUB_TEMPLATE_REPO}/generate`;
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env.GITHUB_PAT),
    body: JSON.stringify({
      owner: env.GITHUB_ORG,
      name: args.repoName,
      description: args.description,
      include_all_branches: false,
      private: args.private,
    }),
  });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_generate_failed:${res.status}`,
      res.status,
      detail,
    );
  }
  const body = (await res.json()) as GeneratedRepo;
  return body;
}

export async function archiveRepo(
  env: Env,
  fullName: string,
): Promise<void> {
  if (isMockMode(env)) {
    return;
  }
  if (!env.GITHUB_PAT) {
    throw new GitHubError(
      "github_pat_unconfigured",
      503,
      "GITHUB_PAT secret must be set",
    );
  }
  const res = await fetch(`${GITHUB_API}/repos/${fullName}`, {
    method: "PATCH",
    headers: ghHeaders(env.GITHUB_PAT),
    body: JSON.stringify({ archived: true }),
  });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_archive_failed:${res.status}`,
      res.status,
      detail,
    );
  }
}
