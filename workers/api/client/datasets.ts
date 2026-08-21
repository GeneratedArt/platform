/**
 * /datasets/ — the Dataset Library: a creator's own curated
 * images/video, private by default.
 * /datasets/detail/?slug=X — one dataset: item grid, upload/import,
 * and the train-a-model flow that turns it into a fal_custom render
 * model version.
 *
 * Two Jekyll pages share this module (query-string routed like
 * /models/detail/?slug=X) — mount() reads cfg.mode to pick which one.
 */
import { installClientErrorReporter } from "./lib/clientErrors";
import { TRAINABLE_BASE_MODELS } from "./lib/trainableBaseModels";

interface DatasetsConfig {
  apiBase: string;
  rootEl: HTMLElement;
  mode: "library" | "detail";
  onUnauthenticated?: () => void;
}

interface Dataset {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  rights_declaration: string;
  visibility: string;
  item_count: number;
  created_at: number;
  updated_at: number;
}

interface DatasetItem {
  id: number;
  kind: string;
  caption: string | null;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  status: string;
  flag_reason: string | null;
  created_at: number;
}

interface TrainingJob {
  id: number;
  dataset_id: number;
  base_model: string;
  training_method: string;
  price_tokens: number;
  render_price_tokens: number;
  status: string;
  model_id: number | null;
  model_version_id: number | null;
  error_code: string | null;
  created_at: number;
  started_at: number | null;
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

const RIGHTS_LABELS: Record<string, string> = {
  own: "My own work",
  licensed: "Licensed to me",
  public_domain: "Public domain / CC0",
};

function renderDatasetCard(d: Dataset): string {
  return `
    <a class="ga-dataset-card" href="/datasets/detail/?slug=${encodeURIComponent(d.slug)}">
      <div class="ga-dataset-card-body">
        <h3 class="h5 mb-1">${escapeHtml(d.title)}</h3>
        <p class="small text-muted mb-2">${escapeHtml(d.description || "No description yet.")}</p>
        <p class="ga-dataset-meta">${d.item_count} item${d.item_count === 1 ? "" : "s"} · ${escapeHtml(RIGHTS_LABELS[d.rights_declaration] || d.rights_declaration)} · ${escapeHtml(d.visibility)}</p>
      </div>
    </a>`;
}

// ---------------------------------------------------------------------------
// Library page
// ---------------------------------------------------------------------------

class LibraryPage {
  private cfg!: DatasetsConfig;

  async mount(cfg: DatasetsConfig): Promise<void> {
    this.cfg = cfg;
    let me: unknown = null;
    try {
      me = await fetchJson(`${cfg.apiBase}/v1/me`);
    } catch {
      me = null;
    }
    if (!me) {
      cfg.onUnauthenticated?.();
      return;
    }
    await this.loadDatasets();
    this.attachEvents();
  }

  private async loadDatasets(): Promise<void> {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-datasets-list");
    if (!el) return;
    try {
      const data = await fetchJson<{ datasets: Dataset[] }>(`${this.cfg.apiBase}/v1/datasets/mine`);
      el.innerHTML = data.datasets.length
        ? data.datasets.map(renderDatasetCard).join("")
        : `<div class="ga-empty p-6 text-center"><p class="small text-muted mb-2">No datasets yet. Your source material stays private — only the models you publish are public.</p></div>`;
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">Failed to load: ${escapeHtml(String(err))}</div>`;
    }
  }

  private attachEvents(): void {
    const form = this.cfg.rootEl.querySelector<HTMLFormElement>("#ga-new-dataset-form");
    form?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const errEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-new-dataset-error");
      errEl?.classList.add("d-none");
      const title = this.cfg.rootEl.querySelector<HTMLInputElement>("#ga-nd-title")!.value.trim();
      const description = this.cfg.rootEl.querySelector<HTMLTextAreaElement>("#ga-nd-description")!.value.trim();
      const rights = this.cfg.rootEl.querySelector<HTMLSelectElement>("#ga-nd-rights")!.value;
      try {
        const data = await fetchJson<{ dataset: Dataset }>(`${this.cfg.apiBase}/v1/datasets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, description: description || undefined, rights_declaration: rights }),
        });
        window.location.href = `/datasets/detail/?slug=${encodeURIComponent(data.dataset.slug)}`;
      } catch (err) {
        if (errEl) {
          errEl.textContent = `Couldn't create dataset: ${String(err)}`;
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
  private cfg!: DatasetsConfig;
  private slug = "";
  private dataset: Dataset | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async mount(cfg: DatasetsConfig): Promise<void> {
    this.cfg = cfg;
    const params = new URLSearchParams(window.location.search);
    this.slug = params.get("slug") || "";
    if (!this.slug) {
      cfg.rootEl.innerHTML = `<p class="text-muted">Bad URL — dataset pages look like /datasets/detail/?slug=your-dataset.</p>`;
      return;
    }
    try {
      const data = await fetchJson<{ dataset: Dataset }>(`${cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}`);
      this.dataset = data.dataset;
    } catch (err) {
      const status = (err as Error).message.startsWith("404") ? 404 : 0;
      if (status === 404) {
        cfg.onUnauthenticated?.();
        return;
      }
      cfg.rootEl.innerHTML = `<p class="text-muted">Failed to load dataset: ${escapeHtml(String(err))}</p>`;
      return;
    }

    this.renderHeader();
    this.populateBaseModelOptions();
    await this.loadItems();
    await this.loadTrainingJobs();
    this.attachEvents();
  }

  private renderHeader(): void {
    const d = this.dataset!;
    const root = this.cfg.rootEl;
    root.querySelector<HTMLElement>("#ga-dataset-title")!.textContent = d.title;
    root.querySelector<HTMLElement>("#ga-dataset-desc")!.textContent = d.description || "No curatorial statement yet.";
    root.querySelector<HTMLElement>("#ga-dataset-meta")!.textContent =
      `${d.item_count} item${d.item_count === 1 ? "" : "s"} · ${RIGHTS_LABELS[d.rights_declaration] || d.rights_declaration} · ${d.visibility}`;
    const trainBtn = root.querySelector<HTMLButtonElement>("#ga-train-submit");
    if (trainBtn) trainBtn.disabled = d.item_count < 5;
    const trainHint = root.querySelector<HTMLElement>("#ga-train-min-hint");
    if (trainHint) trainHint.classList.toggle("d-none", d.item_count >= 5);
  }

  private populateBaseModelOptions(): void {
    const sel = this.cfg.rootEl.querySelector<HTMLSelectElement>("#ga-train-base-model");
    if (!sel) return;
    sel.innerHTML = Object.entries(TRAINABLE_BASE_MODELS)
      .map(([key, base]) => `<option value="${escapeHtml(key)}">${escapeHtml(base.label)}</option>`)
      .join("");
  }

  private async loadItems(): Promise<void> {
    const grid = this.cfg.rootEl.querySelector<HTMLElement>("#ga-dataset-items");
    if (!grid) return;
    try {
      const data = await fetchJson<{ items: DatasetItem[] }>(
        `${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/items?limit=100`,
      );
      grid.innerHTML = data.items.length
        ? data.items.map((i) => this.renderItem(i)).join("")
        : `<p class="small text-muted">No items yet — drop images or video below.</p>`;
    } catch (err) {
      grid.innerHTML = `<div class="alert alert-danger">Failed to load items: ${escapeHtml(String(err))}</div>`;
    }
  }

  private renderItem(i: DatasetItem): string {
    const fileUrl = `${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/items/${i.id}/file`;
    const flagged = i.status === "flagged";
    const thumb = i.kind === "image"
      ? `<img src="${fileUrl}" crossorigin="use-credentials" alt="${escapeHtml(i.caption || "dataset item")}" loading="lazy" />`
      : `<video src="${fileUrl}" crossorigin="use-credentials" muted preload="metadata"></video>`;
    return `
      <div class="ga-dataset-item${flagged ? " ga-dataset-item-flagged" : ""}" data-item-id="${i.id}">
        ${thumb}
        ${flagged ? `<p class="ga-item-flag">${escapeHtml(i.flag_reason || "flagged")}</p>` : ""}
        <button type="button" class="ga-item-delete" data-item-id="${i.id}" title="Remove">×</button>
      </div>`;
  }

  private async loadTrainingJobs(): Promise<void> {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-training-jobs");
    if (!el) return;
    try {
      const data = await fetchJson<{ jobs: TrainingJob[] }>(
        `${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/training`,
      );
      el.innerHTML = data.jobs.length
        ? data.jobs.map((j) => this.renderTrainingJob(j)).join("")
        : `<p class="small text-muted">No training runs yet.</p>`;
      // Poll while any job is still in flight — training is genuinely
      // async at the provider (minutes to hours in production; instant
      // under TRAINING_MOCK).
      const inFlight = data.jobs.some((j) => j.status === "queued" || j.status === "training");
      if (inFlight && !this.pollTimer) {
        this.pollTimer = setInterval(() => void this.loadTrainingJobs(), 4000);
      } else if (!inFlight && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">Failed to load: ${escapeHtml(String(err))}</div>`;
    }
  }

  private renderTrainingJob(j: TrainingJob): string {
    const base = TRAINABLE_BASE_MODELS[j.base_model]?.label ?? j.base_model;
    const when = new Date(j.created_at * 1000).toLocaleString();
    let statusLine: string;
    if (j.status === "succeeded" && j.model_id) {
      statusLine = `<a href="/models/detail/?slug=${j.model_id}">View model →</a>`;
    } else if (j.status === "failed") {
      statusLine = `Failed (${escapeHtml(j.error_code || "unknown")}) — ${j.price_tokens} tokens refunded`;
    } else {
      statusLine = "In progress…";
    }
    return `
      <li class="ga-training-job">
        <div class="d-flex justify-content-between">
          <span>${escapeHtml(base)} · ${escapeHtml(j.training_method)}</span>
          <span class="ga-job-status ga-job-status-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>
        </div>
        <p class="small text-muted mb-0">${escapeHtml(when)} · ${statusLine}</p>
      </li>`;
  }

  private feedback(id: string, msg: string): void {
    const el = this.cfg.rootEl.querySelector<HTMLElement>(id);
    if (el) el.textContent = msg;
  }

  private async uploadFiles(files: FileList): Promise<void> {
    this.feedback("#ga-upload-feedback", `Uploading ${files.length} item(s)…`);
    let ok = 0;
    let dup = 0;
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const res = await fetch(
          `${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/items`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data_url: dataUrl }),
          },
        );
        if (res.status === 201) ok++;
        else if (res.status === 200) dup++;
        else failed++;
      } catch {
        failed++;
      }
    }
    this.feedback(
      "#ga-upload-feedback",
      `${ok} added, ${dup} duplicate${dup === 1 ? "" : "s"} skipped, ${failed} failed.`,
    );
    const fresh = await fetchJson<{ dataset: Dataset }>(`${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}`);
    this.dataset = fresh.dataset;
    this.renderHeader();
    await this.loadItems();
  }

  private async deleteItem(itemId: number): Promise<void> {
    if (!confirm("Remove this item from the dataset?")) return;
    try {
      await fetchJson(`${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/items/${itemId}`, {
        method: "DELETE",
      });
      const fresh = await fetchJson<{ dataset: Dataset }>(`${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}`);
      this.dataset = fresh.dataset;
      this.renderHeader();
      await this.loadItems();
    } catch (err) {
      alert(`Failed to remove item: ${err}`);
    }
  }

  private async submitTraining(): Promise<void> {
    const root = this.cfg.rootEl;
    const errEl = root.querySelector<HTMLElement>("#ga-train-error");
    errEl?.classList.add("d-none");
    const baseModel = root.querySelector<HTMLSelectElement>("#ga-train-base-model")!.value;
    const method = root.querySelector<HTMLSelectElement>("#ga-train-method")!.value;
    const renderPrice = parseInt(root.querySelector<HTMLInputElement>("#ga-train-render-price")!.value, 10) || 25;
    const btn = root.querySelector<HTMLButtonElement>("#ga-train-submit");
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    try {
      await fetchJson(`${this.cfg.apiBase}/v1/datasets/${encodeURIComponent(this.slug)}/train`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_model: baseModel, training_method: method, render_price_tokens: renderPrice }),
      });
      await this.loadTrainingJobs();
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Couldn't start training: ${String(err)}`;
        errEl.classList.remove("d-none");
      }
    } finally {
      if (btn) { btn.disabled = (this.dataset?.item_count ?? 0) < 5; btn.textContent = "Train"; }
    }
  }

  private attachEvents(): void {
    const root = this.cfg.rootEl;
    const dropzone = root.querySelector<HTMLElement>("#ga-dataset-dropzone");
    const fileInput = root.querySelector<HTMLInputElement>("#ga-dataset-file-input");
    dropzone?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => {
      if (fileInput.files?.length) void this.uploadFiles(fileInput.files);
    });
    dropzone?.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropzone.classList.add("ga-dragover");
    });
    dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("ga-dragover"));
    dropzone?.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dropzone.classList.remove("ga-dragover");
      if (ev.dataTransfer?.files.length) void this.uploadFiles(ev.dataTransfer.files);
    });

    root.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const delBtn = target.closest<HTMLButtonElement>(".ga-item-delete");
      if (delBtn) {
        const id = parseInt(delBtn.dataset.itemId || "", 10);
        if (id) void this.deleteItem(id);
      }
    });

    root.querySelector<HTMLFormElement>("#ga-train-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void this.submitTraining();
    });
  }
}

const GADatasets = {
  async mount(cfg: DatasetsConfig) {
    installClientErrorReporter({ apiBase: cfg.apiBase, page: `datasets-${cfg.mode}` });
    if (cfg.mode === "library") await new LibraryPage().mount(cfg);
    else await new DetailPage().mount(cfg);
  },
};

declare global {
  interface Window {
    GADatasets?: typeof GADatasets;
  }
}

window.GADatasets = GADatasets;
export default GADatasets;
