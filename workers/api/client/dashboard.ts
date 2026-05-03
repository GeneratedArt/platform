import { installClientErrorReporter } from "./lib/clientErrors";

interface ProjectSummary {
  id: number;
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

interface MeResponse {
  user: { id: number; address: string; handle: string };
}

interface BootstrapModalInstance {
  show(): void;
  hide(): void;
}
interface BootstrapModalCtor {
  getOrCreateInstance(el: Element): BootstrapModalInstance;
}
interface BootstrapNamespace {
  Modal: BootstrapModalCtor;
}

declare global {
  interface Window {
    GADashboard?: typeof GADashboard;
    bootstrap?: BootstrapNamespace;
  }
}

interface DashboardConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  minted: "Minted",
  archived: "Archived",
};

function statusBadge(status: string): string {
  const cls = `ga-badge ga-badge-${status}`;
  return `<span class="${cls}">${STATUS_LABELS[status] || status}</span>`;
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

function renderProjectCard(p: ProjectSummary): string {
  const isArchived = p.status === "archived";
  const repoLink = p.repo_url
    ? `<a href="${escapeHtml(p.repo_url)}" target="_blank" rel="noopener" class="ga-card-link">View repo →</a>`
    : "";
  const archiveBtn = isArchived
    ? ""
    : `<button class="btn btn-link p-0 text-danger ga-archive-btn" data-project-id="${p.id}">Archive</button>`;
  return `
    <article class="ga-project-card" data-project-id="${p.id}">
      <header>
        <h3 class="h5 mb-1">${escapeHtml(p.title)}</h3>
        <p class="small text-muted mb-2">${escapeHtml(p.engine)} · ${escapeHtml(p.license)}</p>
      </header>
      <p class="small mb-3">${escapeHtml(p.description || "No description yet.")}</p>
      <footer class="d-flex justify-content-between align-items-center">
        <div>${statusBadge(p.status)}</div>
        <div class="d-flex gap-3 align-items-center">
          ${repoLink}
          ${archiveBtn}
        </div>
      </footer>
    </article>
  `;
}

function renderEmpty(): string {
  return `
    <div class="ga-empty p-6 text-center">
      <h3 class="h5 mb-2">No projects yet.</h3>
      <p class="small text-muted mb-0">Click "New project" to create your first generative-art repo.</p>
    </div>
  `;
}

function renderModal(): string {
  return `
    <div class="modal fade" id="ga-new-project-modal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content rounded-0">
          <div class="modal-header">
            <h5 class="modal-title">New project</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <form id="ga-new-project-form">
            <div class="modal-body">
              <div id="ga-new-project-error" class="alert alert-danger d-none small" role="alert"></div>
              <div class="mb-3">
                <label for="ga-np-title" class="form-label small">Title</label>
                <input type="text" required maxlength="80" class="form-control rounded-0" id="ga-np-title" />
              </div>
              <div class="mb-3">
                <label for="ga-np-description" class="form-label small">Short description</label>
                <textarea class="form-control rounded-0" id="ga-np-description" maxlength="500" rows="3"></textarea>
              </div>
              <div class="row">
                <div class="col-6 mb-3">
                  <label for="ga-np-engine" class="form-label small">Engine</label>
                  <select class="form-select rounded-0" id="ga-np-engine">
                    <option value="p5" selected>p5.js</option>
                    <option value="three">three.js</option>
                    <option value="shader">GLSL shader</option>
                    <option value="canvas">canvas / vanilla</option>
                  </select>
                </div>
                <div class="col-6 mb-3">
                  <label for="ga-np-license" class="form-label small">License</label>
                  <select class="form-select rounded-0" id="ga-np-license">
                    <option value="CC-BY-NC-4.0" selected>CC BY-NC 4.0</option>
                    <option value="CC-BY-4.0">CC BY 4.0</option>
                    <option value="MIT">MIT</option>
                    <option value="ARR">All rights reserved</option>
                  </select>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-link" data-bs-dismiss="modal">Cancel</button>
              <button type="submit" class="btn btn-accent rounded-0">Create</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function loadProjects(cfg: DashboardConfig): Promise<void> {
  const listEl = cfg.rootEl.querySelector<HTMLElement>("#ga-project-list");
  if (!listEl) return;
  listEl.innerHTML = `<div class="text-center p-4 text-muted">Loading…</div>`;
  try {
    const { projects } = await fetchJson<{ projects: ProjectSummary[] }>(
      `${cfg.apiBase}/v1/projects/mine`,
    );
    if (!projects.length) {
      listEl.innerHTML = renderEmpty();
    } else {
      listEl.innerHTML = projects.map(renderProjectCard).join("");
    }
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">Failed to load projects: ${escapeHtml(String(err))}</div>`;
  }
}

async function createProject(cfg: DashboardConfig, body: Record<string, unknown>) {
  return fetchJson<{ project: ProjectSummary }>(`${cfg.apiBase}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function archiveProject(cfg: DashboardConfig, id: number) {
  return fetchJson<{ project: ProjectSummary }>(
    `${cfg.apiBase}/v1/projects/${id}/archive`,
    { method: "POST" },
  );
}

function attachEvents(cfg: DashboardConfig) {
  cfg.rootEl.addEventListener("click", async (ev) => {
    const target = ev.target as HTMLElement;
    if (target.matches(".ga-archive-btn")) {
      const id = parseInt(target.getAttribute("data-project-id") || "", 10);
      if (!id) return;
      if (!confirm("Archive this project? The GitHub repo will be archived but its history is preserved.")) return;
      try {
        await archiveProject(cfg, id);
        await loadProjects(cfg);
      } catch (err) {
        alert("Archive failed: " + err);
      }
    }
  });

  const form = cfg.rootEl.querySelector<HTMLFormElement>("#ga-new-project-form");
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const titleEl = cfg.rootEl.querySelector<HTMLInputElement>("#ga-np-title");
    const descEl = cfg.rootEl.querySelector<HTMLTextAreaElement>("#ga-np-description");
    const engineEl = cfg.rootEl.querySelector<HTMLSelectElement>("#ga-np-engine");
    const licenseEl = cfg.rootEl.querySelector<HTMLSelectElement>("#ga-np-license");
    const errEl = cfg.rootEl.querySelector<HTMLElement>("#ga-new-project-error");
    if (!titleEl || !engineEl || !licenseEl || !errEl) return;
    errEl.classList.add("d-none");
    try {
      await createProject(cfg, {
        title: titleEl.value,
        description: descEl?.value || null,
        engine: engineEl.value,
        license: licenseEl.value,
      });
      titleEl.value = "";
      if (descEl) descEl.value = "";
      const modalEl = document.getElementById("ga-new-project-modal");
      if (modalEl && window.bootstrap?.Modal) {
        window.bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }
      await loadProjects(cfg);
    } catch (err) {
      errEl.textContent = "Create failed: " + String(err);
      errEl.classList.remove("d-none");
    }
  });
}

const GADashboard = {
  async mount(cfg: DashboardConfig & { onUnauthenticated?: () => void }) {
    // Task #20: install global error reporter early.
    installClientErrorReporter({ apiBase: cfg.apiBase, page: "dashboard" });
    let me: MeResponse | null = null;
    try {
      me = await fetchJson<MeResponse>(`${cfg.apiBase}/v1/me`);
    } catch {
      me = null;
    }
    if (!me) {
      cfg.onUnauthenticated?.();
      return;
    }
    cfg.rootEl.querySelector<HTMLElement>("#ga-dashboard-handle")!.textContent = me.user.handle;
    cfg.rootEl.querySelector<HTMLElement>("#ga-dashboard-address")!.textContent = me.user.address;

    const modalRoot = cfg.rootEl.querySelector<HTMLElement>("#ga-modal-root");
    if (modalRoot && !modalRoot.innerHTML.trim()) modalRoot.innerHTML = renderModal();
    attachEvents(cfg);
    await loadProjects(cfg);
  },
};

window.GADashboard = GADashboard;
export default GADashboard;
