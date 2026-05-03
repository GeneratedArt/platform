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

/// Test helper: seed the mock store. No-op outside mock mode (so a
/// stray prod call can't pollute state).
export function __setMockFile(
  env: Env,
  fullName: string,
  path: string,
  content: string,
): void {
  if (!isMockMode(env)) return;
  MOCK_FILES.set(mockKey(fullName, path), {
    content,
    sha: syntheticSha(`${fullName}::${path}::${content}`),
  });
}

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

/// Resolve the default branch's HEAD commit SHA for a repo. The
/// freeze pipeline calls this when the user freezes "latest" so the
/// recorded `commit_sha` is a real commit (re-resolvable by the
/// drift-recovery cron) rather than a tree SHA or blob SHA.
export async function getDefaultBranchHeadCommit(
  env: Env,
  fullName: string,
): Promise<{ sha: string; branch: string }> {
  if (isMockMode(env)) {
    return {
      sha: syntheticSha(`head::${fullName}`),
      branch: "main",
    };
  }
  if (!env.GITHUB_PAT) {
    throw new GitHubError("github_pat_unconfigured", 503, "");
  }
  const repoRes = await fetch(`${GITHUB_API}/repos/${fullName}`, {
    headers: ghHeaders(env.GITHUB_PAT),
  });
  if (!repoRes.ok) {
    throw new GitHubError(
      `github_repo_${repoRes.status}`,
      repoRes.status,
      await repoRes.text().catch(() => ""),
    );
  }
  const repo = (await repoRes.json()) as { default_branch: string };
  const branch = repo.default_branch || "main";
  const refRes = await fetch(
    `${GITHUB_API}/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(env.GITHUB_PAT) },
  );
  if (!refRes.ok) {
    throw new GitHubError(
      `github_ref_${refRes.status}`,
      refRes.status,
      await refRes.text().catch(() => ""),
    );
  }
  const ref = (await refRes.json()) as { object: { sha: string } };
  return { sha: ref.object.sha, branch };
}

/// Fetch a blob's raw bytes by sha. Uses the Git Blobs API so binary
/// content (PNGs, fonts, audio) is preserved exactly — the Contents
/// API path runs decoded base64 through a UTF-8 string round-trip
/// which corrupts non-text bytes.
export async function getRepoBlob(
  env: Env,
  fullName: string,
  sha: string,
): Promise<Uint8Array> {
  if (isMockMode(env)) {
    for (const [, file] of MOCK_FILES) {
      if (file.sha === sha) return new TextEncoder().encode(file.content);
    }
    return new Uint8Array();
  }
  if (!env.GITHUB_PAT) {
    throw new GitHubError("github_pat_unconfigured", 503, "");
  }
  const res = await fetch(
    `${GITHUB_API}/repos/${fullName}/git/blobs/${encodeURIComponent(sha)}`,
    { headers: ghHeaders(env.GITHUB_PAT) },
  );
  if (!res.ok) {
    throw new GitHubError(
      `github_blob_${res.status}`,
      res.status,
      await res.text().catch(() => ""),
    );
  }
  const body = (await res.json()) as { content: string; encoding: string };
  if (body.encoding !== "base64") {
    throw new GitHubError("github_blob_encoding", 502, body.encoding);
  }
  const bin = atob(body.content.replace(/\n/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface RepoTreeNode {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

export interface RepoTreeListing {
  files: RepoTreeNode[];
  /// Resolved HEAD commit sha when ref is undefined; otherwise the
  /// caller-supplied ref.
  headSha: string | null;
}

/// List every blob in the repo at `ref` (or the default branch HEAD
/// when ref is undefined). Used by the freeze bundler to enumerate
/// inputs deterministically. Mock mode returns whatever's in the
/// isolate-local MOCK_FILES map for `fullName`.
export async function listRepoTreeAtRef(
  env: Env,
  fullName: string,
  ref?: string,
): Promise<RepoTreeListing> {
  if (isMockMode(env)) {
    const files: RepoTreeNode[] = [];
    for (const key of MOCK_FILES.keys()) {
      const [name, path] = key.split("::");
      if (name !== fullName) continue;
      files.push({ path, type: "blob", sha: MOCK_FILES.get(key)!.sha });
    }
    if (files.length === 0) {
      // Synthesise the starter sketch so a brand-new mock-mode repo
      // still freezes successfully on first call.
      files.push({ path: "sketch.js", type: "blob", sha: "" });
    }
    return { files, headSha: ref ?? "mock-head" };
  }
  if (!env.GITHUB_PAT) {
    throw new GitHubError(
      "github_pat_unconfigured",
      503,
      "GITHUB_PAT secret must be set",
    );
  }
  // Resolve a ref to a tree SHA. When the caller passes a commit
  // SHA we still go through the commits endpoint to extract the
  // tree SHA (`/git/trees/{sha}?recursive=1` accepts a commit SHA
  // directly via the `?recursive=1` shortcut).
  const refOrHead = ref ?? "HEAD";
  const url = `${GITHUB_API}/repos/${fullName}/git/trees/${encodeURIComponent(refOrHead)}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders(env.GITHUB_PAT) });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_tree_failed:${res.status}`,
      res.status,
      detail,
    );
  }
  const body = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string }>;
    sha: string;
    truncated?: boolean;
  };
  if (body.truncated) {
    throw new GitHubError(
      "github_tree_truncated",
      502,
      "tree exceeded the 100k file / 7 MB GitHub API limit; freeze unsupported",
    );
  }
  return {
    files: body.tree
      .filter((n) => n.type === "blob" || n.type === "tree")
      .map((n) => ({
        path: n.path,
        type: n.type as "blob" | "tree",
        sha: n.sha,
      })),
    headSha: body.sha,
  };
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
  ref?: string,
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

  // Optional ?ref= pins the read to a specific commit / branch / tag,
  // which is what the freeze pipeline relies on for true provenance.
  // Without it, GitHub returns whatever's on the default branch HEAD,
  // which is non-deterministic across re-freezes.
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `${GITHUB_API}/repos/${fullName}/contents/${encodeURIComponent(path)}${refQs}`;
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

// In mock mode, deletes silently no-op. Production-only path is the
// GitHub Contents API DELETE.
export async function deleteRepoFile(
  env: Env,
  fullName: string,
  args: { path: string; sha: string; message: string; branch?: string },
): Promise<void> {
  if (isMockMode(env)) {
    MOCK_FILES.delete(mockKey(fullName, args.path));
    return;
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
    sha: args.sha,
  };
  if (args.branch) body.branch = args.branch;
  const res = await fetch(url, {
    method: "DELETE",
    headers: ghHeaders(env.GITHUB_PAT),
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {}
    throw new GitHubError(
      `github_delete_file_failed:${res.status}`,
      res.status,
      detail,
    );
  }
}

// ---------------------------------------------------------------------------
// Author profile mirror
// ---------------------------------------------------------------------------
//
// PATCH /v1/me writes profile fields to D1, but the static `/@{handle}/`
// page is rendered by Jekyll from `_authors/{handle}.md`. To keep the two
// in sync without a Pages-side webhook we commit a freshly-rendered MD
// to the site repo on every save. The site's GitHub Pages workflow
// rebuilds and the static page picks up the new front-matter.
//
// In mock mode (or when GITHUB_SITE_REPO is unset) we no-op gracefully
// and surface a `reason` so the editor can tell the user "static page
// won't update until a human commits the file" without failing the save.

export interface AuthorProfileInput {
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_image: string | null;
  socials: Array<{ label: string; url: string }>;
  address: string;
  // When the handle changes, we delete the old MD so the old route
  // 404s on the next build instead of serving stale data.
  previousHandle?: string | null;
}

export interface AuthorProfileResult {
  committed: boolean;
  reason?: string;
  commit_sha?: string;
  html_url?: string | null;
}

// YAML scalar escaping for front-matter. We only ever produce
// double-quoted scalars to keep escaping rules trivial: backslash and
// double-quote are the only chars that need escaping inside `"…"`.
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Block scalar with literal style for multi-line bios. Each line is
// indented by 2 spaces under the key. An empty bio still emits a key
// with `null` so the front-matter shape is uniform across users.
function yamlBlock(s: string): string {
  const lines = s.split("\n").map((l) => `  ${l}`);
  return `|\n${lines.join("\n")}`;
}

export function renderAuthorProfileMd(input: AuthorProfileInput): string {
  const lines: string[] = ["---"];
  lines.push("layout: profile");
  lines.push(`handle: ${yamlString(input.handle)}`);
  lines.push(
    `title: ${yamlString(input.display_name || input.handle)}`,
  );
  if (input.display_name) {
    lines.push(`display_name: ${yamlString(input.display_name)}`);
  }
  if (input.avatar_url) {
    lines.push(`avatar: ${yamlString(input.avatar_url)}`);
  }
  if (input.cover_image) {
    lines.push(`cover_image: ${yamlString(input.cover_image)}`);
  }
  lines.push(`address: ${yamlString(input.address)}`);
  if (input.bio) {
    lines.push(`bio: ${yamlBlock(input.bio)}`);
  }
  if (input.socials.length > 0) {
    lines.push("socials:");
    for (const s of input.socials) {
      lines.push(`  - label: ${yamlString(s.label)}`);
      lines.push(`    url: ${yamlString(s.url)}`);
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export async function commitAuthorProfile(
  env: Env,
  input: AuthorProfileInput,
): Promise<AuthorProfileResult> {
  const siteRepo = env.GITHUB_SITE_REPO;
  if (!siteRepo) {
    return { committed: false, reason: "site_repo_unconfigured" };
  }
  if (isMockMode(env)) {
    // Still exercise renderAuthorProfileMd via the mock store so dev
    // can `wrangler tail`-style inspect what would land. But report
    // committed=false so the UI reflects "no real commit happened".
    const path = `_authors/${input.handle}.md`;
    const content = renderAuthorProfileMd(input);
    MOCK_FILES.set(mockKey(siteRepo, path), {
      content,
      sha: syntheticSha(`${siteRepo}::${path}:${content.length}`),
    });
    return { committed: false, reason: "mock_mode" };
  }
  if (!env.GITHUB_PAT) {
    return { committed: false, reason: "github_pat_unconfigured" };
  }

  const path = `_authors/${input.handle}.md`;
  const content = renderAuthorProfileMd(input);

  // Look up the existing blob SHA so the PUT is a compare-and-swap.
  // Missing file (first save) → empty SHA → CREATE semantics.
  let existingSha: string | undefined;
  try {
    const existing = await getRepoFile(env, siteRepo, path);
    existingSha = existing.sha || undefined;
  } catch (err) {
    // 404 from the helper returns sha:"" (CREATE), but other errors
    // bubble up. Re-throw so the caller surfaces the GitHub error
    // unchanged.
    if (!(err instanceof GitHubError) || err.status !== 404) throw err;
  }

  const commit = await putRepoFile(env, siteRepo, {
    path,
    content,
    sha: existingSha,
    message: `profile: update ${input.handle}`,
  });

  // If the handle changed, drop the old MD so the old `/@old/` 404s
  // on the next Pages build. Best-effort — a leftover file is a soft
  // failure (the new page works either way).
  if (input.previousHandle && input.previousHandle !== input.handle) {
    try {
      const old = await getRepoFile(env, siteRepo, `_authors/${input.previousHandle}.md`);
      if (old.sha) {
        await deleteRepoFile(env, siteRepo, {
          path: `_authors/${input.previousHandle}.md`,
          sha: old.sha,
          message: `profile: rename ${input.previousHandle} → ${input.handle}`,
        });
      }
    } catch (err) {
      console.error("profile_rename_old_md_cleanup_failed", err);
    }
  }

  return {
    committed: true,
    commit_sha: commit.commit_sha,
    html_url: commit.html_url,
  };
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
