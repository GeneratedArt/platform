// Client bundle for the Briefs board (Task #7).
//
// Exposes three named entry points on `window.GABriefs`:
//   * mountList(cfg)   — /briefs/         listing + industry filter chips
//   * mountNew(cfg)    — /briefs/new/     auth-gated create form
//   * mountDetail(cfg) — /briefs/show/    detail page (read ?id=N)
//
// Markdown is rendered with a tiny built-in sanitiser (escape-first +
// allowlist transforms) so we don't pull in a 30 KB dependency just for
// the demo. Server stores raw markdown; this client renders it. If the
// server's input validation is ever bypassed, the renderer below still
// can't emit script tags or arbitrary attributes — the only HTML it
// produces comes from a fixed set of patterns.

interface BaseConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

const INDUSTRIES = [
  "textile",
  "fashion",
  "architecture",
  "product",
  "gallery",
  "collab",
  "other",
] as const;
type Industry = (typeof INDUSTRIES)[number];

const INDUSTRY_LABELS: Record<Industry, string> = {
  textile: "Textile",
  fashion: "Fashion",
  architecture: "Architecture",
  product: "Product",
  gallery: "Gallery",
  collab: "Collab",
  other: "Other",
};

interface PublicAuthor {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface BriefListItem {
  id: number;
  industry: Industry;
  title: string;
  body_snippet: string;
  budget: string | null;
  deadline: number | null;
  status: string;
  created_at: number;
  author: PublicAuthor;
}

interface BriefDetail {
  id: number;
  industry: Industry;
  title: string;
  body: string;
  budget: string | null;
  deadline: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  author: PublicAuthor;
}

declare global {
  interface Window {
    GABriefs?: typeof GABriefs;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
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

function fmtDate(unix: number): string {
  try {
    return new Date(unix * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Markdown renderer (sanitising-by-construction).
//
// The contract: input is plaintext, the output is a string of HTML that only
// contains the tags we explicitly emit below. The strategy is:
//   1. HTML-escape the entire input first → the source markdown can no longer
//      contain real `<` or quote characters that could escape attributes.
//   2. Run line/inline transforms that emit our allowlisted tags.
// Anything not matched stays as escaped text. We intentionally do NOT support
// raw HTML, images (no remote-URL leak surface), or autolinks for `javascript:`
// schemes — only `https://` and `http://` link targets pass.
// ---------------------------------------------------------------------------
function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src.replace(/\r\n?/g, "\n"));
  const lines = escaped.split("\n");
  const out: string[] = [];
  let i = 0;

  const inline = (s: string): string => {
    // Code spans first so their contents are NOT touched by other transforms.
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
    // Bold / italic. `__text__` and `**text**` for bold; `_text_` / `*text*`
    // for italic. We keep this minimal — no nested combinations.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|\W)_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    // Links: [label](url). url must be http(s):// — otherwise leave as-is.
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      return `<a href="${url}" rel="noopener nofollow ugc" target="_blank">${label}</a>`;
    });
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — flush.
    if (/^\s*$/.test(line)) { i++; continue; }

    // Heading (# / ## / ###).
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length + 2; // h3..h5 to avoid clashing with page h1/h2
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }

    // Blockquote.
    if (/^&gt;\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(inline(lines[i].replace(/^&gt;\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    // Paragraph (consume until blank line).
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|&gt;\s?|[-*]\s+|\d+\.\s+|---+\s*$)/.test(lines[i])
    ) {
      buf.push(inline(lines[i]));
      i++;
    }
    out.push(`<p>${buf.join("<br>")}</p>`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiGet<T>(apiBase: string, path: string): Promise<T | { __status: number }> {
  const res = await fetch(`${apiBase}${path}`, { credentials: "include" });
  if (!res.ok) return { __status: res.status };
  return (await res.json()) as T;
}
async function apiPost<T>(
  apiBase: string,
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; data: unknown }> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, data };
  return { ok: true, data: data as T };
}
function isErr<T>(v: T | { __status: number }): v is { __status: number } {
  return typeof v === "object" && v !== null && "__status" in (v as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Listing page
// ---------------------------------------------------------------------------
async function mountList(cfg: BaseConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const industryParam = params.get("industry");
  const industry: Industry | "" =
    industryParam && (INDUSTRIES as readonly string[]).includes(industryParam)
      ? (industryParam as Industry)
      : "";

  const chipsHtml = (["", ...INDUSTRIES] as Array<Industry | "">)
    .map((ind) => {
      const label = ind === "" ? "All" : INDUSTRY_LABELS[ind];
      const active = ind === industry ? " ga-chip-active" : "";
      const href = ind === ""
        ? "/briefs/"
        : `/briefs/?industry=${encodeURIComponent(ind)}`;
      return `<a class="ga-chip${active}" href="${href}">${escapeHtml(label)}</a>`;
    })
    .join("");

  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <h1 class="h2 mb-2">Briefs</h1>
      <p class="text-muted small mb-3">
        Open commissions and collaboration calls. Sign in to
        <a href="/briefs/new/">post a brief</a>.
      </p>
      <nav class="ga-chips">${chipsHtml}</nav>
    </header>
    <div id="ga-briefs-list" aria-busy="true">
      <p class="text-muted small">Loading briefs…</p>
    </div>
  `;
  const listEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-briefs-list");
  if (!listEl) return;

  const qs = industry ? `?industry=${encodeURIComponent(industry)}` : "";
  const data = await apiGet<{ briefs: BriefListItem[] }>(
    cfg.apiBase, `/v1/briefs${qs}`,
  );
  if (isErr(data)) {
    listEl.innerHTML = `<p class="text-danger small">Couldn't load briefs (HTTP ${data.__status}).</p>`;
    listEl.removeAttribute("aria-busy");
    return;
  }
  if (data.briefs.length === 0) {
    listEl.innerHTML = `
      <div class="ga-empty">
        <p class="text-muted small mb-3">
          ${industry ? `No open briefs in ${escapeHtml(INDUSTRY_LABELS[industry as Industry])} yet.` : "No open briefs yet."}
        </p>
        <a href="/briefs/new/" class="btn btn-accent rounded-0">Post the first one</a>
      </div>
    `;
    listEl.removeAttribute("aria-busy");
    return;
  }

  listEl.innerHTML = data.briefs.map((b) => {
    const handle = escapeHtml(b.author.handle);
    const name = escapeHtml(b.author.display_name || b.author.handle);
    const ind = escapeHtml(INDUSTRY_LABELS[b.industry] || b.industry);
    const budget = b.budget ? `· ${escapeHtml(b.budget)} ETH` : "";
    const deadline = b.deadline ? `· deadline ${escapeHtml(fmtDate(b.deadline))}` : "";
    return `
      <article class="ga-brief-card">
        <p class="ga-brief-meta">
          <span class="ga-brief-industry">${ind}</span>
          · <a href="/@${handle}/">@${handle}</a>
          · ${escapeHtml(fmtDate(b.created_at))}
          ${budget} ${deadline}
        </p>
        <h2 class="h5 mb-1"><a href="/briefs/${b.id}/">${escapeHtml(b.title)}</a></h2>
        <p class="text-muted small mb-0">${escapeHtml(b.body_snippet)}</p>
      </article>
    `;
  }).join("");
  listEl.removeAttribute("aria-busy");
}

// ---------------------------------------------------------------------------
// New-brief form
// ---------------------------------------------------------------------------
async function mountNew(cfg: BaseConfig): Promise<void> {
  // Auth-gate first.
  const me = await apiGet<{ user: { handle: string } }>(cfg.apiBase, "/v1/me");
  if (isErr(me)) {
    cfg.rootEl.innerHTML = `
      <div class="text-center py-10">
        <h1 class="h3 mb-3">Sign in to post a brief.</h1>
        <p class="text-muted mb-4">Connect your wallet so others can find and contact you.</p>
        <a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a>
      </div>
    `;
    return;
  }

  const industryOpts = INDUSTRIES.map(
    (ind) => `<option value="${ind}">${escapeHtml(INDUSTRY_LABELS[ind])}</option>`,
  ).join("");

  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <h1 class="h2 mb-1">Post a brief</h1>
      <p class="small text-muted mb-0">
        Posting as <a href="/@${escapeHtml(me.user.handle)}/" class="ga-mono">@${escapeHtml(me.user.handle)}</a>.
        5 briefs per day. Markdown is supported in the body.
      </p>
    </header>
    <div id="ga-brief-error" class="alert alert-danger d-none small" role="alert"></div>
    <form id="ga-brief-form">
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-industry">Industry</label>
        <select id="ga-brief-industry" class="form-select rounded-0" required>${industryOpts}</select>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-title">Title</label>
        <input type="text" id="ga-brief-title" class="form-control rounded-0" maxlength="200" required />
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-body">Body (markdown)</label>
        <textarea id="ga-brief-body" class="form-control rounded-0" rows="10" maxlength="10000" required></textarea>
        <p class="form-text small text-muted"><span id="ga-brief-body-count">0</span>/10000</p>
      </div>
      <div class="row gx-3">
        <div class="col-md-6 mb-4">
          <label class="form-label small" for="ga-brief-budget">Budget (ETH, optional)</label>
          <input type="text" id="ga-brief-budget" class="form-control rounded-0" pattern="^\\d+(\\.\\d{1,18})?$" placeholder="0.5" />
        </div>
        <div class="col-md-6 mb-4">
          <label class="form-label small" for="ga-brief-deadline">Deadline (optional)</label>
          <input type="date" id="ga-brief-deadline" class="form-control rounded-0" />
        </div>
      </div>
      <div class="mb-4">
        <details>
          <summary class="small text-muted">Preview</summary>
          <div id="ga-brief-preview" class="ga-brief-body mt-3"></div>
        </details>
      </div>
      <button type="submit" class="btn btn-accent rounded-0" id="ga-brief-submit">Post brief</button>
    </form>
  `;

  const form = cfg.rootEl.querySelector<HTMLFormElement>("#ga-brief-form")!;
  const errEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-brief-error")!;
  const bodyEl = cfg.rootEl.querySelector<HTMLTextAreaElement>("#ga-brief-body")!;
  const countEl = cfg.rootEl.querySelector<HTMLSpanElement>("#ga-brief-body-count")!;
  const previewEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-brief-preview")!;
  const submit = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-brief-submit")!;

  const refreshPreview = () => {
    countEl.textContent = String(bodyEl.value.length);
    previewEl.innerHTML = bodyEl.value ? renderMarkdown(bodyEl.value) : "";
  };
  bodyEl.addEventListener("input", refreshPreview);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.classList.add("d-none");
    submit.disabled = true;

    const industry = (cfg.rootEl.querySelector<HTMLSelectElement>("#ga-brief-industry")!).value;
    const title = (cfg.rootEl.querySelector<HTMLInputElement>("#ga-brief-title")!).value.trim();
    const body = bodyEl.value.trim();
    const budgetRaw = (cfg.rootEl.querySelector<HTMLInputElement>("#ga-brief-budget")!).value.trim();
    const deadlineRaw = (cfg.rootEl.querySelector<HTMLInputElement>("#ga-brief-deadline")!).value;

    const payload: Record<string, unknown> = { industry, title, body };
    if (budgetRaw) payload.budget = budgetRaw;
    if (deadlineRaw) {
      // <input type="date"> emits "YYYY-MM-DD"; coerce to unix seconds (UTC).
      const t = Date.parse(`${deadlineRaw}T23:59:59Z`);
      if (Number.isFinite(t)) payload.deadline = Math.floor(t / 1000);
    }

    const res = await apiPost<{ brief: { id: number } }>(cfg.apiBase, "/v1/briefs", payload);
    if (!res.ok) {
      const errStr = (res.data && typeof res.data === "object" && "error" in res.data)
        ? String((res.data as { error: unknown }).error)
        : `HTTP ${res.status}`;
      errEl.textContent = `Couldn't post (${errStr}).`;
      errEl.classList.remove("d-none");
      submit.disabled = false;
      return;
    }
    window.location.href = `/briefs/${res.data.brief.id}/`;
  });
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------
async function mountDetail(cfg: BaseConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = parseInt(params.get("id") || "", 10);
  if (!Number.isFinite(id) || id < 1) {
    cfg.rootEl.innerHTML = `<p class="text-danger small">Missing brief id.</p>`;
    return;
  }

  const data = await apiGet<{ brief: BriefDetail }>(cfg.apiBase, `/v1/briefs/${id}`);
  if (isErr(data)) {
    if (data.__status === 404) {
      cfg.rootEl.innerHTML = `
        <div class="text-center py-10">
          <h1 class="h3 mb-3">Brief not found</h1>
          <p class="text-muted"><a href="/briefs/">Back to all briefs</a></p>
        </div>
      `;
    } else {
      cfg.rootEl.innerHTML = `<p class="text-danger small">Couldn't load (HTTP ${data.__status}).</p>`;
    }
    return;
  }

  const b = data.brief;
  const handle = escapeHtml(b.author.handle);
  const name = escapeHtml(b.author.display_name || b.author.handle);
  const ind = escapeHtml(INDUSTRY_LABELS[b.industry] || b.industry);
  const budget = b.budget ? `<span>Budget · ${escapeHtml(b.budget)} ETH</span>` : "";
  const deadline = b.deadline ? `<span>Deadline · ${escapeHtml(fmtDate(b.deadline))}</span>` : "";
  // Title flows through escapeHtml (plain text), body through the
  // sanitising markdown renderer. Author handle is the source of truth
  // for the link href; display_name is plain-text only.
  cfg.rootEl.innerHTML = `
    <article class="ga-brief-detail">
      <p class="ga-brief-meta">
        <span class="ga-brief-industry">${ind}</span>
        · By <a href="/@${handle}/">${name}</a>
        · ${escapeHtml(fmtDate(b.created_at))}
      </p>
      <h1 class="h2 mb-3">${escapeHtml(b.title)}</h1>
      <div class="ga-brief-facts mb-4">${budget} ${deadline}</div>
      <div class="ga-brief-body"></div>
      <hr>
      <div class="ga-brief-apply">
        <button type="button" class="btn btn-accent rounded-0" id="ga-brief-apply">Apply</button>
        <span id="ga-brief-apply-msg" class="small text-muted ms-3 d-none">Application flow coming soon.</span>
      </div>
    </article>
  `;
  const bodyDiv = cfg.rootEl.querySelector<HTMLDivElement>(".ga-brief-body")!;
  bodyDiv.innerHTML = renderMarkdown(b.body);

  const applyBtn = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-brief-apply")!;
  const applyMsg = cfg.rootEl.querySelector<HTMLSpanElement>("#ga-brief-apply-msg")!;
  applyBtn.addEventListener("click", () => {
    applyMsg.classList.remove("d-none");
    applyBtn.disabled = true;
  });
}

const GABriefs = {
  mountList,
  mountNew,
  mountDetail,
  // Exported so we can unit-test the renderer if needed.
  _renderMarkdown: renderMarkdown,
};

window.GABriefs = GABriefs;
export default GABriefs;
