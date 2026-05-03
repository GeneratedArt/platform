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

interface ProjectOwner {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface FrozenVersion {
  id: number;
  commit_sha: string;
  cid: string;
  cid_w3s: string | null;
  cid_pinata: string | null;
  bundle_hash: string;
  bytes: number;
  pinned_w3s: boolean;
  pinned_pinata: boolean;
  pinning_partial: boolean;
  pin_errors: unknown;
  is_active: boolean;
  last_checked_at: number | null;
  created_at: number;
  gateways: { w3s: string | null; pinata: string | null };
}

interface MeResp {
  user: { id: number; handle: string };
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

async function render(
  cfg: ProjectDetailConfig,
  project: ProjectDetail,
  owner: ProjectOwner | null,
) {
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

  const byline = root.querySelector(".ga-project-author")! as HTMLAnchorElement;
  if (owner) {
    byline.href = `/@${owner.handle}/`;
    byline.textContent = `@${owner.handle}`;
  } else {
    byline.removeAttribute("href");
    byline.textContent = `artist #${project.owner_id}`;
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
    const result = await fetchJson<{
      project: ProjectDetail;
      owner: ProjectOwner | null;
    }>(`${cfg.apiBase}/v1/projects/${id}`);
    if (isErr(result)) {
      renderError(
        cfg,
        result.__status === 404
          ? `Project #${id} doesn't exist (or has been deleted).`
          : `Couldn't load project #${id} (${result.__status}).`,
      );
      return;
    }
    await render(cfg, result.project, result.owner ?? null);
    await mountFreezePanel(cfg, result.project);
    await mountTraitsPanel(cfg, result.project);
  },
};

// ---------------------------------------------------------------------------
// Task #18: traits + recent mints panel.
// ---------------------------------------------------------------------------
// Public; renders distinct (trait_name → values) with rarity bars and
// links each value to /explore/?trait=name:value. We also list the most
// recent minted tokens with deep-links to /t/?p=N&id=T. The whole
// panel is silently skipped if the project hasn't been minted yet
// or has no captured traits.

interface TraitsResp {
  project_id: number;
  minted: number;
  traits: {
    name: string;
    distinct_count: number;
    values: { trait_value: string; count: number; frequency: number }[];
  }[];
}

interface MintsResp {
  project_id: number;
  mints: {
    id: number;
    token_id: string;
    owner_address: string;
    minted_at: number;
    traits: Record<string, string> | null;
  }[];
}

async function mountTraitsPanel(
  cfg: ProjectDetailConfig,
  project: ProjectDetail,
) {
  const host = cfg.rootEl.querySelector(".ga-project-detail");
  if (!host) return;

  const panel = document.createElement("section");
  panel.className = "ga-traits-panel mt-8 pt-6";
  panel.style.borderTop = "1px solid var(--ga-rule)";
  panel.innerHTML = `
    <h2 class="h5 mb-1">Traits</h2>
    <p class="small text-muted mb-3">
      Captured at mint time from the artist's <code>$features(seed)</code>.
      Click any value to find other tokens that share it.
    </p>
    <div class="ga-traits-body small">Loading…</div>
    <h2 class="h5 mt-6 mb-1">Recent mints</h2>
    <div class="ga-mints-body small">Loading…</div>
  `;
  host.appendChild(panel);

  const traitsEl = panel.querySelector(".ga-traits-body") as HTMLElement;
  const mintsEl = panel.querySelector(".ga-mints-body") as HTMLElement;

  const [traitsRes, mintsRes] = await Promise.all([
    fetchJson<TraitsResp>(`${cfg.apiBase}/v1/projects/${project.id}/traits`),
    fetchJson<MintsResp>(
      `${cfg.apiBase}/v1/projects/${project.id}/mints?limit=20`,
    ),
  ]);

  if (isErr(traitsRes) || traitsRes.minted === 0 || traitsRes.traits.length === 0) {
    traitsEl.innerHTML = `<p class="text-muted">No traits captured yet — they appear here once tokens are minted.</p>`;
  } else {
    traitsEl.innerHTML = traitsRes.traits
      .map((t) => renderTraitGroup(t))
      .join("");
  }

  if (isErr(mintsRes) || mintsRes.mints.length === 0) {
    mintsEl.innerHTML = `<p class="text-muted">No mints yet.</p>`;
  } else {
    mintsEl.innerHTML = `
      <div class="ga-mints-grid">
        ${mintsRes.mints.map((m) => renderMintCard(project.id, m)).join("")}
      </div>`;
  }
}

function renderTraitGroup(t: {
  name: string;
  values: { trait_value: string; count: number; frequency: number }[];
}): string {
  return `
    <div class="ga-trait-group" style="margin-bottom: 14px;">
      <div class="ga-trait-name" style="font-family: var(--ga-font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ga-mute); margin-bottom: 6px;">
        ${escapeHtml(t.name)}
      </div>
      <ul class="list-unstyled mb-0">
        ${t.values
          .map(
            (v) => `
          <li style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--ga-rule);">
            <a href="/explore/?trait=${encodeURIComponent(t.name)}:${encodeURIComponent(v.trait_value)}"
               style="font-family: var(--ga-font-mono); font-size: 13px; color: var(--ga-ink); border-bottom: 1px solid var(--ga-rule);">
              ${escapeHtml(v.trait_value)}
            </a>
            <span class="text-muted" style="font-family: var(--ga-font-mono); font-size: 12px;">
              ${v.count} · ${(v.frequency * 100).toFixed(1)}%
            </span>
          </li>`,
          )
          .join("")}
      </ul>
    </div>
  `;
}

function renderMintCard(
  projectId: number,
  m: {
    token_id: string;
    owner_address: string;
    minted_at: number;
    traits: Record<string, string> | null;
  },
): string {
  const ownerShort = `${m.owner_address.slice(0, 6)}…${m.owner_address.slice(-4)}`;
  const ts = new Date(m.minted_at * 1000).toLocaleDateString();
  const traitCount = m.traits ? Object.keys(m.traits).length : 0;
  return `
    <a class="ga-mint-card" href="/t/?p=${projectId}&id=${encodeURIComponent(m.token_id)}"
       style="display:block; border:1px solid var(--ga-rule); padding:10px 12px; text-decoration:none; color: inherit;">
      <div style="font-family: var(--ga-font-mono); font-size: 12px; color: var(--ga-ink);">
        #${escapeHtml(m.token_id)}
      </div>
      <div class="text-muted" style="font-family: var(--ga-font-mono); font-size: 11px; margin-top: 2px;">
        ${escapeHtml(ownerShort)} · ${escapeHtml(ts)}
      </div>
      <div class="text-muted" style="font-size: 11px; margin-top: 4px;">
        ${traitCount} ${traitCount === 1 ? "trait" : "traits"}
      </div>
    </a>
  `;
}

// ---------------------------------------------------------------------------
// Task #15: freeze panel.
// ---------------------------------------------------------------------------
// Visible to all viewers (the CIDs and hashes are public anyway), but
// the "Freeze current commit" + "Activate" buttons only render for the
// project owner. We do a lightweight `/v1/me` probe to decide; the
// endpoint 401s for anonymous viewers, which we treat as "not owner".

async function mountFreezePanel(
  cfg: ProjectDetailConfig,
  project: ProjectDetail,
) {
  const host = cfg.rootEl.querySelector(".ga-project-detail");
  if (!host) return;

  const panel = document.createElement("section");
  panel.className = "ga-freeze-panel mt-8 pt-6";
  panel.style.borderTop = "1px solid var(--ga-rule)";
  panel.innerHTML = `
    <h2 class="h5 mb-1">Frozen versions</h2>
    <p class="small text-muted mb-3">
      Each frozen version is a deterministic, content-addressed bundle
      pinned to web3.storage and Pinata. The active version's CID is
      what gets locked into the project contract at mint time.
    </p>
    <div class="ga-freeze-actions mb-3 d-none">
      <div class="d-flex flex-wrap align-items-center gap-2">
        <input type="text"
          class="ga-freeze-commit form-control form-control-sm rounded-0"
          style="max-width:280px;font-family:monospace;font-size:12px;"
          placeholder="commit SHA (blank = latest)"
          aria-label="Commit SHA to freeze" />
        <button type="button" class="btn btn-accent btn-sm rounded-0" data-action="freeze">
          Freeze
        </button>
        <span class="ga-freeze-status small text-muted ms-2"></span>
      </div>
      <p class="small text-muted mt-1 mb-0">
        Leave commit blank to freeze the default branch's HEAD.
      </p>
    </div>
    <div class="ga-freeze-list small">Loading…</div>
  `;
  host.appendChild(panel);

  const listEl = panel.querySelector(".ga-freeze-list") as HTMLElement;
  const actionsEl = panel.querySelector(".ga-freeze-actions") as HTMLElement;
  const statusEl = panel.querySelector(".ga-freeze-status") as HTMLElement;
  const freezeBtn = panel.querySelector(
    "[data-action='freeze']",
  ) as HTMLButtonElement;
  const commitInput = panel.querySelector(
    ".ga-freeze-commit",
  ) as HTMLInputElement;

  // Probe ownership.
  let isOwner = false;
  try {
    const me = await fetchJson<MeResp>(`${cfg.apiBase}/v1/me`);
    if (!isErr(me)) isOwner = me.user.id === project.owner_id;
  } catch {
    isOwner = false;
  }
  if (isOwner) actionsEl.classList.remove("d-none");

  async function refresh() {
    const r = await fetchJson<{
      versions: FrozenVersion[];
      active: FrozenVersion | null;
    }>(`${cfg.apiBase}/v1/projects/${project.id}/frozen`);
    if (isErr(r)) {
      listEl.innerHTML = `<p class="text-muted">Couldn't load frozen versions (${r.__status}).</p>`;
      return;
    }
    if (r.versions.length === 0) {
      listEl.innerHTML = `<p class="text-muted">No frozen versions yet.${
        isOwner ? " Click <em>Freeze current commit</em> to create one." : ""
      }</p>`;
      return;
    }
    listEl.innerHTML = r.versions
      .map((v) => renderFrozenRow(v, isOwner))
      .join("");
    listEl.querySelectorAll<HTMLButtonElement>("[data-activate]").forEach(
      (btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Activating…";
          const fid = btn.getAttribute("data-activate");
          const res = await fetch(
            `${cfg.apiBase}/v1/projects/${project.id}/frozen/${fid}/activate`,
            { method: "POST", credentials: "include" },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            statusEl.textContent = `Activate failed: ${
              (err as { error?: string }).error || res.status
            }`;
          }
          await refresh();
        });
      },
    );
    listEl.querySelectorAll<HTMLButtonElement>("[data-retry-pin]").forEach(
      (btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Retrying…";
          const fid = btn.getAttribute("data-retry-pin");
          const res = await fetch(
            `${cfg.apiBase}/v1/projects/${project.id}/frozen/${fid}/retry-pin`,
            { method: "POST", credentials: "include" },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            statusEl.textContent = `Retry pin failed: ${
              (err as { error?: string }).error || res.status
            }`;
          } else {
            statusEl.textContent = "Retry pin succeeded.";
          }
          await refresh();
        });
      },
    );
  }

  freezeBtn?.addEventListener("click", async () => {
    freezeBtn.disabled = true;
    const commit = (commitInput?.value || "").trim() || "latest";
    statusEl.textContent =
      commit === "latest"
        ? "Building bundle from HEAD + pinning…"
        : `Building bundle from ${commit.slice(0, 12)} + pinning…`;
    const res = await fetch(
      `${cfg.apiBase}/v1/projects/${project.id}/freeze`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit }),
      },
    );
    freezeBtn.disabled = false;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `Freeze failed: ${
        (err as { error?: string }).error || res.status
      }`;
      return;
    }
    statusEl.textContent = "Frozen. Activate it below to make it the live version.";
    if (commitInput) commitInput.value = "";
    await refresh();
  });

  await refresh();
}

function renderFrozenRow(
  v: FrozenVersion,
  isOwner: boolean,
): string {
  const sizeKB = (v.bytes / 1024).toFixed(1);
  const created = new Date(v.created_at * 1000).toLocaleString();
  const pinBadges = [
    v.pinned_w3s ? "✓ web3.storage" : "✗ web3.storage",
    v.pinned_pinata ? "✓ Pinata" : "✗ Pinata",
  ].join(" · ");
  const partialNote = v.pinning_partial
    ? `<span class="ga-badge ga-badge-archived ms-2">Partial pin</span>`
    : "";
  const activeBadge = v.is_active
    ? `<span class="ga-badge ga-badge-minted ms-2">Active</span>`
    : "";
  const activateBtn =
    isOwner && !v.is_active &&
    (v.pinned_w3s || v.pinned_pinata)
      ? `<button type="button" class="btn btn-sm btn-outline-primary rounded-0 ms-2" data-activate="${v.id}">Activate</button>`
      : "";
  const retryBtn =
    isOwner && v.pinning_partial
      ? `<button type="button" class="btn btn-sm btn-outline-secondary rounded-0 ms-2" data-retry-pin="${v.id}" title="Rebuild from commit and re-pin to the dropped provider">Retry pin</button>`
      : "";
  // Each provider's CID and gateway link, when known. Showing them
  // separately reflects the reality that w3s and Pinata produce
  // different CIDs for the same bytes.
  const w3sLine = v.cid_w3s
    ? `<a href="${escapeHtml(v.gateways.w3s || "")}" target="_blank" rel="noopener">w3s.link ↗</a> <code style="font-size:11px;">${escapeHtml(v.cid_w3s.slice(0, 18))}…</code>`
    : `<span class="text-muted">w3s: not pinned</span>`;
  const pinataLine = v.cid_pinata
    ? `<a href="${escapeHtml(v.gateways.pinata || "")}" target="_blank" rel="noopener">pinata ↗</a> <code style="font-size:11px;">${escapeHtml(v.cid_pinata.slice(0, 18))}…</code>`
    : `<span class="text-muted">pinata: not pinned</span>`;
  return `
    <div class="ga-freeze-row" style="border:1px solid var(--ga-rule); padding:12px; margin-bottom:8px;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <code style="font-size:12px;">${escapeHtml(v.cid)}</code>
        <span>${activeBadge}${partialNote}${activateBtn}${retryBtn}</span>
      </div>
      <div class="text-muted" style="font-size:12px; line-height:1.5;">
        <div>commit <code>${escapeHtml(v.commit_sha.slice(0, 12))}</code> · sha256 <code>${escapeHtml(v.bundle_hash.slice(0, 16))}…</code> · ${sizeKB} KB</div>
        <div>${pinBadges} · ${escapeHtml(created)}</div>
        <div>${w3sLine} · ${pinataLine}</div>
      </div>
    </div>
  `;
}

window.GAProjectDetail = GAProjectDetail;
export default GAProjectDetail;
