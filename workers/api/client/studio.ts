import { installClientErrorReporter } from "./lib/clientErrors";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";

const BRAND_PAPER = "#FAFAF7";
const BRAND_INK = "#0A0A0A";
const BRAND_ACCENT = "#E63946";
const BRAND_RULE = "rgba(10, 10, 10, 0.12)";
const BRAND_MUTE = "rgba(10, 10, 10, 0.55)";
const BRAND_SELECT = "rgba(230, 57, 70, 0.18)";

const brandEditorTheme = EditorView.theme(
  {
    "&": {
      color: BRAND_INK,
      backgroundColor: BRAND_PAPER,
      height: "100%",
    },
    ".cm-content": {
      caretColor: BRAND_ACCENT,
      fontFamily:
        'ui-monospace, "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace',
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: BRAND_ACCENT },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: BRAND_SELECT },
    ".cm-gutters": {
      backgroundColor: BRAND_PAPER,
      color: BRAND_MUTE,
      borderRight: `1px solid ${BRAND_RULE}`,
    },
    ".cm-activeLine": { backgroundColor: "rgba(10, 10, 10, 0.03)" },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(10, 10, 10, 0.04)",
      color: BRAND_INK,
    },
    ".cm-selectionMatch": { backgroundColor: "rgba(230, 57, 70, 0.12)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(230, 57, 70, 0.18)",
      outline: "none",
    },
    ".cm-tooltip": {
      backgroundColor: BRAND_PAPER,
      color: BRAND_INK,
      border: `1px solid ${BRAND_RULE}`,
    },
    ".cm-panels": {
      backgroundColor: BRAND_PAPER,
      color: BRAND_INK,
      borderTop: `1px solid ${BRAND_RULE}`,
    },
  },
  { dark: false },
);

const brandHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: BRAND_ACCENT, fontWeight: "600" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: BRAND_INK },
  { tag: [t.propertyName], color: BRAND_INK },
  { tag: [t.function(t.variableName), t.labelName], color: BRAND_INK, fontWeight: "600" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: BRAND_ACCENT },
  { tag: [t.definition(t.name), t.separator], color: BRAND_INK },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: BRAND_ACCENT },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: BRAND_ACCENT },
  { tag: [t.meta, t.comment], color: BRAND_MUTE, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: BRAND_ACCENT, textDecoration: "underline" },
  { tag: t.heading, fontWeight: "700", color: BRAND_INK },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: BRAND_ACCENT },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#1f6feb" },
  { tag: t.invalid, color: BRAND_ACCENT, textDecoration: "underline" },
]);

const brandTheme = [brandEditorTheme, syntaxHighlighting(brandHighlightStyle)];

interface MeResponse {
  user: { id: number; address: string; handle: string };
}
interface ProjectMeta {
  id: number;
  slug: string;
  title: string;
  engine: string;
  repo_full: string;
  repo_url: string | null;
}
interface FileResponse {
  file: { path: string; content: string; sha: string };
  project: ProjectMeta;
}
interface CommitResponse {
  commit: { commit_sha: string; content_sha: string; html_url: string | null };
}
interface CaptureResponse {
  capture: { key: string; url: string; bytes: number };
}

interface StudioConfig {
  apiBase: string;
  projectId: number;
  onUnauthenticated?: () => void;
}

declare global {
  interface Window {
    GAStudio?: typeof GAStudio;
  }
}

const SKETCH_PATH = "sketch.js";
const PREVIEW_DEBOUNCE_MS = 200;
const AUTOSAVE_INTERVAL_MS = 5000;
const DEFAULT_SEED = 1;

function lsKey(projectId: number) {
  return `ga.studio.${projectId}`;
}

interface LocalSnapshot {
  code: string;
  /** Blob SHA known at the time we snapshotted. */
  remoteSha: string;
  saved_at: number;
}

function loadLocal(projectId: number): LocalSnapshot | null {
  try {
    const raw = localStorage.getItem(lsKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw) as LocalSnapshot;
  } catch {
    return null;
  }
}

function saveLocal(projectId: number, snap: LocalSnapshot) {
  try {
    localStorage.setItem(lsKey(projectId), JSON.stringify(snap));
  } catch {}
}

function clearLocal(projectId: number) {
  try {
    localStorage.removeItem(lsKey(projectId));
  } catch {}
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
    let detail: unknown = "";
    try { detail = await res.json(); } catch {}
    const msg = typeof detail === "object" && detail && "error" in detail
      ? (detail as { error: string }).error
      : res.statusText;
    const err = new Error(`${res.status}: ${msg}`);
    (err as Error & { status?: number; detail?: unknown }).status = res.status;
    (err as Error & { status?: number; detail?: unknown }).detail = detail;
    throw err;
  }
  return (await res.json()) as T;
}

interface ToastOptions {
  tone?: "info" | "success" | "error";
  ms?: number;
}

function toast(message: string, opts: ToastOptions = {}) {
  const el = document.getElementById("ga-studio-toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = opts.tone || "info";
  el.dataset.show = "1";
  setTimeout(() => { el.dataset.show = "0"; }, opts.ms ?? 2200);
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
function setStatus(state: SaveState, text?: string) {
  const el = document.getElementById("ga-studio-status");
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text ?? ({
    idle: "Idle",
    dirty: "Unsaved",
    saving: "Saving…",
    saved: "Saved",
    error: "Error",
  } as Record<SaveState, string>)[state];
}

class StudioController {
  private cfg: StudioConfig;
  private view: EditorView | null = null;
  private previewIframe: HTMLIFrameElement | null = null;
  private previewReady = false;
  private currentSha = "";
  private originalContent = "";
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private exportRequests = new Map<string, (data: string | Error) => void>();
  private project: ProjectMeta | null = null;
  private copilotMode: "generate" | "edit" | "explain" | "params" = "generate";
  // Holds a generate/edit suggestion until the artist explicitly
  // accepts it — see ai/copilot.ts for why this is accept-the-whole-
  // suggestion rather than per-hunk diffing in v1.
  private pendingSuggestion: string | null = null;

  constructor(cfg: StudioConfig) {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (!this.cfg.projectId) {
      toast("Missing ?project=ID in the URL.", { tone: "error", ms: 5000 });
      return;
    }

    let me: MeResponse | null = null;
    try {
      me = await fetchJson<MeResponse>(`${this.cfg.apiBase}/v1/me`);
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 401) {
        this.cfg.onUnauthenticated?.();
        return;
      }
      toast("Failed to verify your session.", { tone: "error", ms: 4000 });
      return;
    }
    if (!me) {
      this.cfg.onUnauthenticated?.();
      return;
    }

    let fileRes: FileResponse;
    try {
      fileRes = await fetchJson<FileResponse>(
        `${this.cfg.apiBase}/v1/projects/${this.cfg.projectId}/file?path=${encodeURIComponent(SKETCH_PATH)}`,
      );
    } catch (err) {
      toast("Failed to load sketch: " + (err as Error).message, { tone: "error", ms: 5000 });
      return;
    }

    this.project = fileRes.project;
    this.originalContent = fileRes.file.content;
    this.currentSha = fileRes.file.sha;
    this.renderHeader();

    // Restore-or-discard prompt: only show if the local copy
    // actually diverges from the latest server snapshot (different
    // code) AND the local snapshot was taken against a sha that
    // matches OR predates the current remote sha. If the remote sha
    // is newer than the snapshot's `remoteSha` it means someone else
    // committed and the local copy is genuinely stale — surface
    // that explicitly in the banner.
    let initialContent = this.originalContent;
    const local = loadLocal(this.cfg.projectId);
    if (local && local.code !== this.originalContent) {
      const remoteChanged = local.remoteSha && local.remoteSha !== this.currentSha;
      initialContent = await this.promptRestore(local, this.originalContent, remoteChanged);
    }

    this.mountEditor(initialContent);
    this.mountPreviewBridge();
    this.bindToolbar();
    this.bindCopilot();
    this.startAutosave();
    this.startWindowGuards();

    // Kick the preview now even if iframe hasn't said ready yet —
    // it'll be queued by the bridge.
    this.scheduleReload(initialContent);
  }

  private renderHeader() {
    if (!this.project) return;
    const titleEl = document.getElementById("ga-studio-title");
    const metaEl = document.getElementById("ga-studio-meta");
    const repoEl = document.getElementById("ga-studio-repo") as HTMLAnchorElement | null;
    if (titleEl) titleEl.textContent = this.project.title;
    if (metaEl) metaEl.textContent = `${this.project.engine} · ${this.project.repo_full}`;
    if (repoEl && this.project.repo_url) {
      repoEl.href = this.project.repo_url;
      repoEl.hidden = false;
    }
    document.title = `${this.project.title} — Studio`;
    setStatus("idle", "Loaded");
  }

  private async promptRestore(
    local: LocalSnapshot,
    remoteContent: string,
    remoteChanged: boolean,
  ): Promise<string> {
    return new Promise((resolve) => {
      const banner = document.getElementById("ga-studio-restore");
      const yes = document.getElementById("ga-studio-restore-yes");
      const no = document.getElementById("ga-studio-restore-no");
      if (!banner || !yes || !no) {
        resolve(remoteContent);
        return;
      }
      const label = banner.querySelector("span");
      if (label) {
        label.textContent = remoteChanged
          ? "The remote sketch was updated elsewhere AND you have an unsaved local copy."
          : "An unsaved local copy is newer than the remote.";
      }
      banner.classList.remove("d-none");
      const cleanup = () => {
        banner.classList.add("d-none");
        yes.removeEventListener("click", onYes);
        no.removeEventListener("click", onNo);
      };
      const onYes = () => {
        cleanup();
        // Mark dirty so the editor knows the local copy diverges
        // from the server snapshot.
        this.dirty = true;
        setStatus("dirty");
        resolve(local.code);
      };
      const onNo = () => {
        cleanup();
        clearLocal(this.cfg.projectId);
        resolve(remoteContent);
      };
      yes.addEventListener("click", onYes);
      no.addEventListener("click", onNo);
    });
  }

  private mountEditor(initial: string) {
    const root = document.getElementById("ga-studio-editor");
    if (!root) return;
    const editableCompartment = new Compartment();
    const onChange = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      this.dirty = this.view!.state.doc.toString() !== this.originalContent;
      setStatus(this.dirty ? "dirty" : "idle");
      this.scheduleReload();
    });
    const saveKey = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => { void this.commit(); return true; },
        },
        {
          key: "Mod-e",
          preventDefault: true,
          run: () => { void this.exportPng(); return true; },
        },
      ]),
    );
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        javascript(),
        brandTheme,
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        saveKey,
        onChange,
      ],
    });
    this.view = new EditorView({ state, parent: root });
  }

  private mountPreviewBridge() {
    this.previewIframe = document.getElementById("ga-studio-preview") as HTMLIFrameElement | null;
    window.addEventListener("message", (ev: MessageEvent) => {
      // Only trust messages from our own preview iframe. The iframe
      // is sandboxed without allow-same-origin so its origin is
      // "null" — we can't filter on origin, but we CAN filter on
      // source (window reference identity), which catches messages
      // injected from a sibling iframe or popup.
      if (!this.previewIframe || ev.source !== this.previewIframe.contentWindow) {
        return;
      }
      const data = ev.data || {};
      if (data.type === "studio:ready") {
        this.previewReady = true;
        this.scheduleReload();
      } else if (data.type === "studio:png") {
        const cb = this.exportRequests.get(data.requestId);
        if (cb) {
          this.exportRequests.delete(data.requestId);
          if (data.error) cb(new Error(data.error));
          else cb(data.data_url as string);
        }
      } else if (data.type === "studio:error") {
        // Surface runtime errors quietly — the preview iframe
        // already shows them in its red banner.
        console.warn("[studio preview]", data.message);
      }
    });
  }

  private bindToolbar() {
    document.getElementById("ga-studio-save")?.addEventListener("click", () => {
      void this.commit();
    });
    document.getElementById("ga-studio-export")?.addEventListener("click", () => {
      void this.exportPng();
    });
  }

  private readonly COPILOT_PRICES: Record<typeof this.copilotMode, number> = {
    generate: 20,
    edit: 15,
    explain: 5,
    params: 5,
  };
  private readonly COPILOT_PLACEHOLDERS: Record<typeof this.copilotMode, string> = {
    generate: "Describe the sketch you want…",
    edit: "Describe the change — e.g. \"make the background black\"…",
    explain: "(uses your current code — no input needed)",
    params: "(uses your current code — no input needed)",
  };

  private async refreshCopilotBalance(): Promise<void> {
    const el = document.getElementById("ga-copilot-balance");
    if (!el) return;
    try {
      const acct = await fetchJson<{ balance: number }>(`${this.cfg.apiBase}/v1/tokens/account`);
      el.textContent = `${acct.balance.toLocaleString()} tokens`;
    } catch {
      el.textContent = "—";
    }
  }

  private bindCopilot() {
    const toggle = document.getElementById("ga-studio-copilot-toggle");
    const grid = document.getElementById("ga-studio-grid");
    toggle?.addEventListener("click", () => {
      const opening = !grid?.classList.contains("ga-copilot-open");
      grid?.classList.toggle("ga-copilot-open");
      document.getElementById("ga-studio-copilot")?.classList.toggle("d-none", !opening);
      if (opening) void this.refreshCopilotBalance();
    });

    const priceEl = document.getElementById("ga-copilot-price");
    const inputEl = document.getElementById("ga-copilot-input") as HTMLTextAreaElement | null;
    const updateModeUi = () => {
      if (priceEl) priceEl.textContent = `${this.COPILOT_PRICES[this.copilotMode]} tokens`;
      if (inputEl) {
        inputEl.placeholder = this.COPILOT_PLACEHOLDERS[this.copilotMode];
        const needsInput = this.copilotMode === "generate" || this.copilotMode === "edit";
        inputEl.classList.toggle("d-none", !needsInput);
      }
    };
    updateModeUi();

    document.querySelectorAll<HTMLButtonElement>(".ga-copilot-mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ga-copilot-mode").forEach((b) => b.classList.toggle("active", b === btn));
        this.copilotMode = (btn.dataset.gaMode as typeof this.copilotMode) || "generate";
        updateModeUi();
      });
    });

    document.getElementById("ga-copilot-run")?.addEventListener("click", () => {
      void this.runCopilot();
    });
  }

  private copilotFeedback(msg: string): void {
    const el = document.getElementById("ga-copilot-feedback");
    if (el) el.textContent = msg;
  }

  private async runCopilot(): Promise<void> {
    const runBtn = document.getElementById("ga-copilot-run") as HTMLButtonElement | null;
    const resultEl = document.getElementById("ga-copilot-result");
    const inputEl = document.getElementById("ga-copilot-input") as HTMLTextAreaElement | null;
    if (!resultEl || !this.view) return;
    const mode = this.copilotMode;
    const currentCode = this.view.state.doc.toString();
    const prompt = inputEl?.value.trim() || "";
    if ((mode === "generate" || mode === "edit") && !prompt) {
      this.copilotFeedback("Describe what you want first.");
      return;
    }

    if (runBtn) runBtn.disabled = true;
    this.copilotFeedback("Thinking…");
    resultEl.innerHTML = "";
    try {
      let path: string;
      let body: Record<string, unknown>;
      if (mode === "generate") {
        path = "generate";
        body = { prompt };
      } else if (mode === "edit") {
        path = "edit";
        body = { current_code: currentCode, instruction: prompt };
      } else if (mode === "explain") {
        path = "explain";
        body = { code: currentCode };
      } else {
        path = "params";
        body = { code: currentCode };
      }

      const res = await fetch(`${this.cfg.apiBase}/v1/projects/${this.cfg.projectId}/ai/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 402) {
        const err = (await res.json().catch(() => ({}))) as { balance?: number; shortfall?: number };
        this.copilotFeedback(
          `Not enough tokens — need ${err.shortfall ?? "more"} more. `,
        );
        resultEl.innerHTML = `<a href="/wallet/" class="btn btn-outline-dark rounded-0 btn-sm">Buy tokens</a>`;
        return;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        this.copilotFeedback(`Failed: ${err.error ?? res.statusText}`);
        return;
      }
      const data = (await res.json()) as { result: unknown; price_tokens: number };
      this.copilotFeedback(`Spent ${data.price_tokens} tokens.`);
      void this.refreshCopilotBalance();

      if (mode === "generate" || mode === "edit") {
        this.pendingSuggestion = data.result as string;
        resultEl.innerHTML = `
          <div class="ga-copilot-suggestion">${escapeHtml(this.pendingSuggestion)}</div>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-accent rounded-0 btn-sm" id="ga-copilot-accept">Accept</button>
            <button type="button" class="btn btn-outline-dark rounded-0 btn-sm" id="ga-copilot-reject">Reject</button>
          </div>`;
        resultEl.querySelector("#ga-copilot-accept")?.addEventListener("click", () => this.acceptSuggestion());
        resultEl.querySelector("#ga-copilot-reject")?.addEventListener("click", () => {
          this.pendingSuggestion = null;
          resultEl.innerHTML = "";
        });
      } else if (mode === "explain") {
        resultEl.innerHTML = `<p class="small">${escapeHtml(String(data.result))}</p>`;
      } else {
        const params = data.result as Array<{ name: string; kind: string; default: unknown; line_hint: string }>;
        resultEl.innerHTML = params.length
          ? `<ul class="ga-copilot-params-list">${params
              .map((p) => `<li>${escapeHtml(p.name)} <span class="text-muted">(${escapeHtml(p.kind)}, default ${escapeHtml(String(p.default))})</span></li>`)
              .join("")}</ul>`
          : `<p class="small text-muted">Nothing tunable found.</p>`;
      }
    } catch (e) {
      this.copilotFeedback(`Failed: ${(e as Error).message}`);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  /**
   * Replaces the whole editor buffer with the pending suggestion —
   * the accept-the-whole-suggestion simplification documented in
   * ai/copilot.ts, not per-hunk application. Marks the buffer dirty so
   * the existing Save flow (and its Cmd/Ctrl+S binding) picks it up
   * exactly like a manual edit.
   */
  private acceptSuggestion(): void {
    if (!this.view || this.pendingSuggestion === null) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: this.pendingSuggestion },
    });
    this.pendingSuggestion = null;
    document.getElementById("ga-copilot-result")!.innerHTML = "";
    this.copilotFeedback("Applied to the editor — remember to Save.");
  }

  private scheduleReload(forcedCode?: string) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pushPreview(forcedCode);
    }, PREVIEW_DEBOUNCE_MS);
  }

  private pushPreview(forcedCode?: string) {
    if (!this.previewIframe || !this.previewIframe.contentWindow) return;
    if (!this.previewReady) return;
    const code = forcedCode ?? this.view?.state.doc.toString() ?? "";
    this.previewIframe.contentWindow.postMessage(
      { type: "studio:setSrc", code, seed: DEFAULT_SEED },
      "*",
    );
  }

  private startAutosave() {
    const snapshot = () => {
      if (!this.view) return;
      const code = this.view.state.doc.toString();
      if (code === this.originalContent) return;
      saveLocal(this.cfg.projectId, {
        code,
        remoteSha: this.currentSha,
        saved_at: Date.now(),
      });
    };
    this.autosaveTimer = setInterval(snapshot, AUTOSAVE_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") snapshot();
    });
    window.addEventListener("blur", snapshot);
  }

  private startWindowGuards() {
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  private async commit() {
    if (!this.view || !this.project) return;
    const code = this.view.state.doc.toString();
    if (!this.dirty && code === this.originalContent) {
      toast("Nothing to commit.", { tone: "info", ms: 1400 });
      return;
    }
    setStatus("saving");
    try {
      const res = await fetchJson<CommitResponse>(
        `${this.cfg.apiBase}/v1/projects/${this.project.id}/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: SKETCH_PATH,
            content: code,
            sha: this.currentSha || undefined,
            // Worker defaults to `studio: {ISO}` if omitted.
          }),
        },
      );
      this.currentSha = res.commit.content_sha;
      this.originalContent = code;
      this.dirty = false;
      clearLocal(this.cfg.projectId);
      setStatus("saved", `Saved · ${res.commit.commit_sha.slice(0, 7)}`);
      toast("Committed " + res.commit.commit_sha.slice(0, 7), { tone: "success" });
    } catch (err) {
      setStatus("error", "Save failed");
      const status = (err as Error & { status?: number }).status;
      if (status === 409) {
        toast("Conflict — refresh to pull the newer remote.", { tone: "error", ms: 4000 });
      } else if (status === 401) {
        this.cfg.onUnauthenticated?.();
      } else {
        toast("Save failed: " + (err as Error).message, { tone: "error", ms: 4000 });
      }
    }
  }

  private async exportPng() {
    if (!this.previewIframe?.contentWindow || !this.previewReady || !this.project) {
      toast("Preview isn't ready yet.", { tone: "error" });
      return;
    }
    const requestId = `png-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStatus("saving", "Exporting…");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      this.exportRequests.set(requestId, (v) => {
        if (v instanceof Error) reject(v);
        else resolve(v);
      });
      this.previewIframe!.contentWindow!.postMessage(
        { type: "studio:exportPng", requestId },
        "*",
      );
      setTimeout(() => {
        if (this.exportRequests.has(requestId)) {
          this.exportRequests.delete(requestId);
          reject(new Error("export_timeout"));
        }
      }, 8000);
    }).catch((err: Error) => {
      toast("Export failed: " + err.message, { tone: "error", ms: 4000 });
      setStatus("idle");
      return null;
    });
    if (!dataUrl) return;

    try {
      const res = await fetchJson<CaptureResponse>(
        `${this.cfg.apiBase}/v1/projects/${this.project.id}/captures`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data_url: dataUrl, seed: String(DEFAULT_SEED) }),
        },
      );
      try {
        await navigator.clipboard.writeText(res.capture.url);
        toast("PNG uploaded — URL copied.", { tone: "success", ms: 3000 });
      } catch {
        toast("PNG uploaded: " + res.capture.url, { tone: "success", ms: 4000 });
      }
      setStatus(this.dirty ? "dirty" : "idle");
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 503) {
        // Captures bucket isn't bound — fall back to a local download
        // so the demo still works without R2.
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${this.project.slug}-${Date.now()}.png`;
        a.click();
        toast("Captures bucket not configured — downloaded locally.", {
          tone: "info",
          ms: 4000,
        });
        setStatus(this.dirty ? "dirty" : "idle");
      } else {
        toast("Upload failed: " + (err as Error).message, { tone: "error", ms: 4000 });
        setStatus("error", "Upload failed");
      }
    }
  }
}

const GAStudio = {
  mount(cfg: StudioConfig) {
    installClientErrorReporter({ apiBase: cfg.apiBase, page: "studio" });
    const ctrl = new StudioController(cfg);
    void ctrl.start();
  },
};

window.GAStudio = GAStudio;
export default GAStudio;
