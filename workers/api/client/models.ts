/**
 * /models/ — public catalogue + "my models" + publish flow.
 * /models/detail/?slug=X — one model: provenance, versions, publish a
 * new version (owner-only), and the render form (everyone, gated by
 * visibility/price).
 *
 * Two Jekyll pages share this module (query-string routed like
 * /p/?id=N and /t/?p=N&id=T) — `mount()` reads `cfg.mode` to pick
 * which one it's rendering into.
 */
import { installClientErrorReporter } from "./lib/clientErrors";

interface ModelsConfig {
  apiBase: string;
  rootEl: HTMLElement;
  mode: "catalogue" | "detail";
}

interface Owner {
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface ModelSummary {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  kind: string;
  provider: string;
  visibility: string;
  status: string;
  created_at: number;
  updated_at: number;
  latest_version: number | null;
  latest_price_tokens: number | null;
  run_count: number;
  owner?: Owner;
}

interface ModelVersion {
  id: number;
  version: number;
  provider_model_id: string;
  system_prompt?: string;
  params_schema: unknown;
  price_tokens: number;
  training_method: string | null;
  base_model: string | null;
  dataset_note: string | null;
  weights_ref?: string;
  created_at: number;
}

interface RenderJob {
  id: number;
  model_version_id: number;
  project_id: number | null;
  seed: string;
  params: Record<string, unknown> | null;
  status: string;
  price_tokens: number;
  output_kind: string | null;
  output_text: string | null;
  output_key: string | null;
  output_hash: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

const KIND_LABELS: Record<string, string> = { code: "Code", image: "Image" };
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  workers_ai: "Workers AI",
  fal_custom: "Custom-trained",
  mock: "Mock",
};

function provenanceTag(v: Pick<ModelVersion, "base_model" | "training_method">): string {
  if (!v.base_model) return "";
  const method = v.training_method ? ` · ${escapeHtml(v.training_method)}` : "";
  return `<span class="ga-model-provenance">${escapeHtml(v.base_model)}${method}</span>`;
}

function renderModelCard(m: ModelSummary): string {
  const owner = m.owner
    ? `<a href="/@${escapeHtml(m.owner.handle)}/" class="ga-model-owner">@${escapeHtml(m.owner.handle)}</a>`
    : "";
  const price =
    m.latest_price_tokens !== null
      ? `${m.latest_price_tokens.toLocaleString()} tokens / run`
      : "unpublished";
  return `
    <a class="ga-model-card" href="/models/detail/?slug=${encodeURIComponent(m.slug)}">
      <div class="ga-model-card-body">
        <p class="ga-model-meta">${escapeHtml(KIND_LABELS[m.kind] || m.kind)} · ${escapeHtml(PROVIDER_LABELS[m.provider] || m.provider)}</p>
        <h3 class="h5 mb-1">${escapeHtml(m.title)}</h3>
        <p class="small text-muted mb-2">${escapeHtml(m.description || "No description yet.")}</p>
        <p class="ga-model-stats">${escapeHtml(price)} · ${m.run_count} run${m.run_count === 1 ? "" : "s"}</p>
        ${owner}
      </div>
    </a>`;
}

function renderEmptyModels(): string {
  return `<div class="ga-empty p-6 text-center"><p class="small text-muted mb-0">No models yet.</p></div>`;
}

// ---------------------------------------------------------------------------
// Catalogue page
// ---------------------------------------------------------------------------

class CataloguePage {
  private cfg!: ModelsConfig;
  private isAuthed = false;

  async mount(cfg: ModelsConfig): Promise<void> {
    this.cfg = cfg;
    try {
      await fetchJson(`${cfg.apiBase}/v1/me`);
      this.isAuthed = true;
    } catch {
      this.isAuthed = false;
    }
    const mineSection = cfg.rootEl.querySelector<HTMLElement>("#ga-models-mine-section");
    if (mineSection) mineSection.classList.toggle("d-none", !this.isAuthed);

    await this.loadCatalogue();
    if (this.isAuthed) await this.loadMine();
    this.attachEvents();
  }

  private async loadCatalogue(kind?: string): Promise<void> {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-models-catalogue");
    if (!el) return;
    el.innerHTML = `<div class="text-center p-4 text-muted">Loading…</div>`;
    try {
      const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
      const data = await fetchJson<{ models: ModelSummary[] }>(`${this.cfg.apiBase}/v1/models${qs}`);
      el.innerHTML = data.models.length ? data.models.map(renderModelCard).join("") : renderEmptyModels();
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">Failed to load: ${escapeHtml(String(err))}</div>`;
    }
  }

  private async loadMine(): Promise<void> {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-models-mine");
    if (!el) return;
    try {
      const data = await fetchJson<{ models: ModelSummary[] }>(`${this.cfg.apiBase}/v1/models/mine`);
      el.innerHTML = data.models.length ? data.models.map(renderModelCard).join("") : renderEmptyModels();
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">Failed to load: ${escapeHtml(String(err))}</div>`;
    }
  }

  private attachEvents(): void {
    this.cfg.rootEl.querySelectorAll<HTMLButtonElement>("[data-ga-kind-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.cfg.rootEl
          .querySelectorAll("[data-ga-kind-filter]")
          .forEach((b) => b.classList.toggle("active", b === btn));
        const kind = btn.dataset.gaKindFilter || "";
        void this.loadCatalogue(kind || undefined);
      });
    });

    const form = this.cfg.rootEl.querySelector<HTMLFormElement>("#ga-new-model-form");
    form?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const errEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-new-model-error");
      errEl?.classList.add("d-none");
      const title = this.cfg.rootEl.querySelector<HTMLInputElement>("#ga-nm-title")!.value.trim();
      const kind = this.cfg.rootEl.querySelector<HTMLSelectElement>("#ga-nm-kind")!.value;
      const provider = this.cfg.rootEl.querySelector<HTMLSelectElement>("#ga-nm-provider")!.value;
      const description = this.cfg.rootEl.querySelector<HTMLTextAreaElement>("#ga-nm-description")!.value.trim();
      try {
        const data = await fetchJson<{ model: ModelSummary }>(`${this.cfg.apiBase}/v1/models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, kind, provider, description: description || undefined, visibility: "private" }),
        });
        window.location.href = `/models/detail/?slug=${encodeURIComponent(data.model.slug)}`;
      } catch (err) {
        if (errEl) {
          errEl.textContent = `Couldn't create model: ${String(err)}`;
          errEl.classList.remove("d-none");
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

class DetailPage {
  private cfg!: ModelsConfig;
  private slug = "";
  private model: ModelSummary | null = null;
  private versions: ModelVersion[] = [];
  private isOwner = false;

  async mount(cfg: ModelsConfig): Promise<void> {
    this.cfg = cfg;
    const params = new URLSearchParams(window.location.search);
    this.slug = params.get("slug") || "";
    if (!this.slug) {
      cfg.rootEl.innerHTML = `<p class="text-muted">Bad URL — model pages look like /models/detail/?slug=your-model.</p>`;
      return;
    }

    let me: { user: { handle: string } } | null = null;
    try {
      me = await fetchJson(`${cfg.apiBase}/v1/me`);
    } catch {
      me = null;
    }

    try {
      const data = await fetchJson<{ model: ModelSummary; versions: ModelVersion[] }>(
        `${cfg.apiBase}/v1/models/${encodeURIComponent(this.slug)}`,
      );
      this.model = data.model;
      this.versions = data.versions;
    } catch (err) {
      cfg.rootEl.innerHTML = `<p class="text-muted">Model not found: ${escapeHtml(String(err))}</p>`;
      return;
    }

    this.isOwner = !!me && !!this.model.owner && me.user.handle === this.model.owner.handle;
    this.render();
    this.attachEvents();
  }

  private render(): void {
    const m = this.model!;
    const root = this.cfg.rootEl;
    root.querySelector<HTMLElement>("#ga-model-title")!.textContent = m.title;
    root.querySelector<HTMLElement>("#ga-model-desc")!.textContent = m.description || "No description yet.";
    root.querySelector<HTMLElement>("#ga-model-meta")!.textContent =
      `${KIND_LABELS[m.kind] || m.kind} · ${PROVIDER_LABELS[m.provider] || m.provider} · ${m.visibility}`;

    const versionsEl = root.querySelector<HTMLElement>("#ga-model-versions");
    if (versionsEl) {
      versionsEl.innerHTML = this.versions.length
        ? this.versions
            .map(
              (v) => `
        <li class="ga-model-version">
          <div class="d-flex justify-content-between align-items-baseline">
            <span class="ga-version-num">v${v.version}</span>
            <span class="ga-version-price">${v.price_tokens.toLocaleString()} tokens</span>
          </div>
          <p class="small font-monospace mb-1">${escapeHtml(v.provider_model_id)}</p>
          ${provenanceTag(v)}
          ${v.dataset_note ? `<p class="small text-muted mt-1 mb-0">${escapeHtml(v.dataset_note)}</p>` : ""}
        </li>`,
            )
            .join("")
        : `<li class="text-muted small">No published versions yet.</li>`;
    }

    const publishSection = root.querySelector<HTMLElement>("#ga-publish-version-section");
    publishSection?.classList.toggle("d-none", !this.isOwner);
    const providerHint = root.querySelector<HTMLElement>("#ga-pv-provider-hint");
    if (providerHint) {
      providerHint.textContent =
        m.provider === "fal_custom"
          ? "This is a custom-trained model — base model, training method, and weights_ref are required."
          : m.provider === "anthropic"
            ? "Provider model id, e.g. claude-opus-5."
            : "Provider model id from the Workers AI catalogue, e.g. @cf/black-forest-labs/flux-1-schnell.";
    }
    root.querySelectorAll<HTMLElement>(".ga-fal-only").forEach((el) =>
      el.classList.toggle("d-none", m.provider !== "fal_custom"),
    );
    root.querySelectorAll<HTMLElement>(".ga-code-only").forEach((el) =>
      el.classList.toggle("d-none", m.kind !== "code"),
    );

    const latest = this.versions[0];
    const renderSection = root.querySelector<HTMLElement>("#ga-render-section");
    if (renderSection) {
      renderSection.classList.toggle("d-none", !latest || m.status !== "active");
      const priceEl = root.querySelector<HTMLElement>("#ga-render-price");
      if (priceEl && latest) priceEl.textContent = `${latest.price_tokens.toLocaleString()} tokens`;
    }
  }

  private async publishVersion(): Promise<void> {
    const root = this.cfg.rootEl;
    const errEl = root.querySelector<HTMLElement>("#ga-pv-error");
    errEl?.classList.add("d-none");
    const providerModelId = root.querySelector<HTMLInputElement>("#ga-pv-provider-model-id")!.value.trim();
    const priceTokens = parseInt(root.querySelector<HTMLInputElement>("#ga-pv-price")!.value, 10);
    const body: Record<string, unknown> = { provider_model_id: providerModelId, price_tokens: priceTokens };

    if (this.model!.provider === "fal_custom") {
      body.training_method = root.querySelector<HTMLSelectElement>("#ga-pv-training-method")!.value;
      body.base_model = root.querySelector<HTMLInputElement>("#ga-pv-base-model")!.value.trim();
      body.dataset_note = root.querySelector<HTMLTextAreaElement>("#ga-pv-dataset-note")!.value.trim();
      body.weights_ref = root.querySelector<HTMLInputElement>("#ga-pv-weights-ref")!.value.trim();
    } else if (this.model!.kind === "code") {
      body.system_prompt = root.querySelector<HTMLTextAreaElement>("#ga-pv-system-prompt")?.value.trim() || undefined;
    }

    try {
      await fetchJson(`${this.cfg.apiBase}/v1/models/${encodeURIComponent(this.slug)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      window.location.reload();
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Couldn't publish: ${String(err)}`;
        errEl.classList.remove("d-none");
      }
    }
  }

  private async render_(button: HTMLButtonElement): Promise<void> {
    const root = this.cfg.rootEl;
    const prompt = root.querySelector<HTMLTextAreaElement>("#ga-render-prompt")!.value.trim();
    const resultEl = root.querySelector<HTMLElement>("#ga-render-result")!;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Rendering…";
    resultEl.innerHTML = "";
    try {
      const data = await fetchJson<{ job: RenderJob }>(
        `${this.cfg.apiBase}/v1/models/${encodeURIComponent(this.slug)}/render`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );
      this.renderResult(data.job, resultEl);
    } catch (err) {
      resultEl.innerHTML = `<div class="alert alert-danger">Render failed: ${escapeHtml(String(err))}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  private renderResult(job: RenderJob, el: HTMLElement): void {
    if (job.status === "failed") {
      el.innerHTML = `<div class="alert alert-danger">Render failed (${escapeHtml(job.error_code || "unknown")}) — tokens refunded.</div>`;
      return;
    }
    const seedLine = `<p class="small text-muted font-monospace mb-2">seed ${escapeHtml(job.seed)}</p>`;
    if (job.output_kind === "code" && job.output_text) {
      el.innerHTML = `${seedLine}<pre class="ga-render-code">${escapeHtml(job.output_text)}</pre>`;
    } else if (job.output_kind === "image" && job.output_key) {
      const src = `${this.cfg.apiBase}/v1/captures/${job.output_key}`;
      el.innerHTML = `${seedLine}<img class="ga-render-image" src="${src}" alt="Render result" />`;
    } else {
      el.innerHTML = `${seedLine}<p class="small text-muted">Render succeeded with no returned output.</p>`;
    }
  }

  private attachEvents(): void {
    const root = this.cfg.rootEl;
    root.querySelector<HTMLFormElement>("#ga-publish-version-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void this.publishVersion();
    });
    root.querySelector<HTMLButtonElement>("#ga-render-btn")?.addEventListener("click", (ev) => {
      void this.render_(ev.currentTarget as HTMLButtonElement);
    });
  }
}

const GAModels = {
  async mount(cfg: ModelsConfig) {
    installClientErrorReporter({ apiBase: cfg.apiBase, page: `models-${cfg.mode}` });
    if (cfg.mode === "catalogue") await new CataloguePage().mount(cfg);
    else await new DetailPage().mount(cfg);
  },
};

declare global {
  interface Window {
    GAModels?: typeof GAModels;
  }
}

window.GAModels = GAModels;
export default GAModels;
