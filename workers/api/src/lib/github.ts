import type { Env } from "../types";

const GITHUB_API = "https://api.github.com";

export interface GeneratedRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export interface RepoFile {
  /** Decoded UTF-8 content. */
  content: string;
  /** Blob SHA — required for subsequent updates so GitHub can detect conflicts. */
  sha: string;
  path: string;
}

export interface CommitResult {
  /** Commit SHA, NOT blob SHA. */
  commit_sha: string;
  /** New blob SHA, used as the next If-Match for the editor. */
  content_sha: string;
  html_url: string | null;
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

// In mock mode we keep an isolate-local store so the studio can
// round-trip GET/PUT against a fake "repo" without ever touching
// GitHub. Best-effort only — wiped on isolate cold-start. Production
// (mock OFF) hits the real Contents API.
const MOCK_FILES = new Map<string, { content: string; sha: string }>();

function mockKey(fullName: string, path: string): string {
  return `${fullName}::${path}`;
}

function syntheticSha(seed: string): string {
  // Deterministic-ish 40-char hex — good enough to detect "did the
  // server-side state change?" in the editor's compare-and-swap.
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return (h.toString(16).padStart(8, "0").repeat(5)).slice(0, 40);
}

const STARTER_SKETCH = `// Welcome to GeneratedArt Studio.
// Edit and your sketch live-previews on the right. Press Cmd/Ctrl+S to commit.

function setup() {
  createCanvas(720, 720);
  noStroke();
  background(245, 243, 238);
}

function draw() {
  const t = frameCount * 0.01;
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < 6; i++) {
    const a = t + i;
    const r = 60 + i * 30;
    fill(20, 20, 20, 18);
    circle(cx + cos(a) * r, cy + sin(a) * r, 80);
  }
}
`;

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

function b64encode(s: string): string {
  // GitHub Contents API requires base64-encoded content. We're in a
  // Workers runtime so btoa is available — but it only handles
  // latin1, so widen via a TextEncoder + binary-string conversion.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(s.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function getRepoFile(
  env: Env,
  fullName: string,
  path: string,
): Promise<RepoFile> {
  if (isMockMode(env)) {
    const key = mockKey(fullName, path);
    const existing = MOCK_FILES.get(key);
    if (existing) {
      return { content: existing.content, sha: existing.sha, path };
    }
    // First read of a fresh project — return a starter sketch and
    // SEED the mock store so subsequent commits compare-and-swap.
    const sha = syntheticSha(`${key}:init`);
    MOCK_FILES.set(key, { content: STARTER_SKETCH, sha });
    return { content: STARTER_SKETCH, sha, path };
  }

  if (!env.GITHUB_PAT) {
    throw new GitHubError(
      "github_pat_unconfigured",
      503,
      "GITHUB_PAT secret must be set",
    );
  }

  const url = `${GITHUB_API}/repos/${fullName}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: ghHeaders(env.GITHUB_PAT) });
  if (res.status === 404) {
    // File doesn't exist yet — first commit will create it. Return
    // the starter sketch and an empty sha; commit handler must omit
    // `sha` when creating a new file.
    return { content: STARTER_SKETCH, sha: "", path };
  }
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_get_file_failed:${res.status}`,
      res.status,
      detail,
    );
  }
  const body = (await res.json()) as {
    content: string;
    encoding: string;
    sha: string;
  };
  if (body.encoding !== "base64") {
    throw new GitHubError(
      "github_unexpected_encoding",
      502,
      `expected base64, got ${body.encoding}`,
    );
  }
  return { content: b64decode(body.content), sha: body.sha, path };
}

export async function putRepoFile(
  env: Env,
  fullName: string,
  args: {
    path: string;
    content: string;
    sha?: string;
    message: string;
    branch?: string;
  },
): Promise<CommitResult> {
  if (isMockMode(env)) {
    const key = mockKey(fullName, args.path);
    const existing = MOCK_FILES.get(key);
    if (args.sha && existing && existing.sha !== args.sha) {
      throw new GitHubError(
        "github_sha_mismatch",
        409,
        "blob sha does not match — refresh and retry",
      );
    }
    const newSha = syntheticSha(`${key}:${args.content.length}:${Date.now()}`);
    MOCK_FILES.set(key, { content: args.content, sha: newSha });
    return {
      commit_sha: syntheticSha(`commit:${key}:${Date.now()}`),
      content_sha: newSha,
      html_url: `https://github.com/${fullName}/blob/main/${args.path}`,
    };
  }

  if (!env.GITHUB_PAT) {
    throw new GitHubError(
      "github_pat_unconfigured",
      503,
      "GITHUB_PAT secret must be set",
    );
  }

  const url = `${GITHUB_API}/repos/${fullName}/contents/${encodeURIComponent(args.path)}`;
  const body: Record<string, unknown> = {
    message: args.message,
    content: b64encode(args.content),
  };
  if (args.sha) body.sha = args.sha;
  if (args.branch) body.branch = args.branch;
  const res = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(env.GITHUB_PAT),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_put_file_failed:${res.status}`,
      res.status,
      detail,
    );
  }
  const json = (await res.json()) as {
    content: { sha: string; html_url: string };
    commit: { sha: string };
  };
  return {
    commit_sha: json.commit.sha,
    content_sha: json.content.sha,
    html_url: json.content.html_url,
  };
}
