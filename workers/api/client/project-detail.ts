interface ProjectDetail {
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

interface PublicUser {
  id: number;
  handle: string;
  display_name: string | null;
}

interface ProjectDetailConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

declare global {
  interface Window {
    GAProjectDetail?: typeof GAProjectDetail;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

async function fetchJson<T>(url: string): Promise<T | { __status: number }> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return { __status: res.status };
  return (await res.json()) as T;
}

function isErr<T>(v: T | { __status: number }): v is { __status: number } {
  return typeof v === "object" && v !== null && "__status" in (v as Record<string, unknown>);
}

function badgeClass(status: string): string {
  switch (status) {
    case "minted": return "ga-badge ga-badge-minted";
    case "archived": return "ga-badge ga-badge-archived";
    case "draft": return "ga-badge ga-badge-draft";
    default: return "ga-badge ga-badge-published";
  }
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  minted: "Minted",
  archived: "Archived",
};

async function findOwner(cfg: ProjectDetailConfig, ownerId: number): Promise<PublicUser | null> {
  // The /v1/users endpoint is keyed by handle, not id. We don't have a
  // by-id endpoint yet, so we look up the project owner via /v1/me when
  // the viewer is the owner, otherwise fall back to "anon" — the project
  // shipping a `repo_full` like "GeneratedArt-artists/handle-slug" gives
  // us the handle as the prefix before the first dash. Best-effort,
  // good enough for MVP demo flow.
  const me = await fetchJson<{ user: PublicUser }>(`${cfg.apiBase}/v1/me`);
  if (!isErr(me) && me.user.id === ownerId) {
    return me.user;
  }
  return null;
}

function ownerHandleFromRepo(repoFull: string | null, slug: string): string | null {
  if (!repoFull) return null;
  // repo names are `${handle}-${title-slug}`; the project slug is the
  // same string. The handle is the prefix up to the first dash that
  // matches the slug head. For demo accuracy we just split repoFull's
  // name by `-` and take the first token — handles are 2-31 chars of
  // [a-z0-9-] so this is wrong if a handle itself contains dashes. We
  // mark this UNRESOLVED in that case (no link rendered).
  const name = repoFull.split("/")[1] || "";
  if (!name) return null;
  const dash = name.indexOf("-");
  if (dash <= 0) return null;
  const headGuess = name.slice(0, dash);
  // Only trust the guess if it looks consistent with the slug:
  // slug = `${handle}-${title}` so handle must be a prefix of slug too.
  if (!slug.startsWith(headGuess + "-")) return null;
  return headGuess;
}

async function render(cfg: ProjectDetailConfig, project: ProjectDetail) {
  const tmpl = document.getElementById("ga-project-tmpl") as HTMLTemplateElement | null;
  if (!tmpl) return;
  const node = tmpl.content.cloneNode(true) as DocumentFragment;
  const root = node.querySelector(".ga-project-detail")!;

  root.querySelector(".ga-project-title")!.textContent = project.title;
  root.querySelector(".ga-project-engine")!.textContent = project.engine;
  root.querySelector(".ga-project-license")!.textContent = project.license;

  const statusEl = root.querySelector(".ga-project-status")!;
  statusEl.innerHTML = `<span class="${badgeClass(project.status)}">${escapeHtml(STATUS_LABELS[project.status] || project.status)}</span>`;

  const desc = root.querySelector(".ga-project-description")!;
  desc.textContent = project.description || "No description yet.";

  const repoLink = root.querySelector<HTMLAnchorElement>(".ga-project-repo")!;
  if (project.repo_url) {
    repoLink.href = project.repo_url;
    repoLink.textContent = (project.repo_full || project.repo_url) + " ↗";
  } else {
    repoLink.parentElement!.innerHTML = `<span class="text-muted">Repo not linked.</span>`;
  }

  const coverWrap = root.querySelector(".ga-project-cover")!;
  if (project.cover_url) {
    coverWrap.innerHTML = `<img src="${escapeHtml(project.cover_url)}" alt="${escapeHtml(project.title)}" />`;
  }

  const updated = root.querySelector(".ga-project-updated")!;
  const updatedDate = new Date(project.updated_at * 1000);
  updated.textContent = `Updated ${updatedDate.toLocaleDateString()}`;

  // Best-effort owner attribution. If we can resolve a handle, link to
  // `/@handle/`; otherwise show the address-style fallback.
  const byline = root.querySelector(".ga-project-author")! as HTMLAnchorElement;
  const me = await findOwner(cfg, project.owner_id);
  if (me) {
    byline.href = `/@${me.handle}/`;
    byline.textContent = `@${me.handle}`;
  } else {
    const guess = ownerHandleFromRepo(project.repo_full, project.slug);
    if (guess) {
      byline.href = `/@${guess}/`;
      byline.textContent = `@${guess}`;
    } else {
      byline.removeAttribute("href");
      byline.textContent = `artist #${project.owner_id}`;
    }
  }

  cfg.rootEl.innerHTML = "";
  cfg.rootEl.appendChild(node);
  document.title = `${project.title} — GeneratedArt`;
}

function renderError(cfg: ProjectDetailConfig, message: string) {
  cfg.rootEl.innerHTML = `
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Project not found</h1>
      <p class="text-muted small mb-4">${escapeHtml(message)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>
  `;
}

const GAProjectDetail = {
  async mount(cfg: ProjectDetailConfig) {
    const params = new URLSearchParams(window.location.search);
    const idStr = params.get("id");
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!id || Number.isNaN(id)) {
      renderError(cfg, "No project id provided. Project URLs look like /p/?id=123.");
      return;
    }
    const result = await fetchJson<{ project: ProjectDetail }>(
      `${cfg.apiBase}/v1/projects/${id}`,
    );
    if (isErr(result)) {
      renderError(
        cfg,
        result.__status === 404
          ? `Project #${id} doesn't exist (or has been deleted).`
          : `Couldn't load project #${id} (${result.__status}).`,
      );
      return;
    }
    await render(cfg, result.project);
  },
};

window.GAProjectDetail = GAProjectDetail;
export default GAProjectDetail;
