// Client bundle for Galleries (Task #19).
// Exposes `window.GAGalleries` with mountList, mountDetail, mountNew, mountEdit.

interface BaseConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

interface PublicCurator {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface GalleryListItem {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  location: string | null;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  project_count: number;
  curator: PublicCurator | null;
}

interface GalleryProject {
  project_id: number;
  position: number;
  created_at: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  cover_url: string | null;
  last_capture_key: string | null;
  frozen_cid: string | null;
  owner_id: number;
  owner_handle: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
}

interface GalleryDetail {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  body_md: string | null;
  cover_url: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
  curator: PublicCurator | null;
  projects: GalleryProject[];
}

declare global {
  interface Window {
    GAGalleries?: typeof GAGalleries;
  }
}

// ---------------------------------------------------------------------------
// Helpers (same patterns as briefs.ts).
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function fmtDate(unix: number): string {
  try {
    return new Date(unix * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch { return ""; }
}

function fmtRange(starts: number | null, ends: number | null): string {
  if (!starts && !ends) return "";
  if (starts && ends) return `${fmtDate(starts)} – ${fmtDate(ends)}`;
  return fmtDate((starts ?? ends) as number);
}

// Tiny markdown renderer — same allowlist as the briefs renderer:
// escape-first then emit only a fixed set of tags. Kept inline so the
// galleries bundle has no shared-state dependency on the briefs bundle.
function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src.replace(/\r\n?/g, "\n"));
  const lines = escaped.split("\n");
  const out: string[] = [];
  let i = 0;
  const inline = (s: string): string => {
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|\W)_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      return `<a href="${url}" rel="noopener nofollow ugc" target="_blank">${label}</a>`;
    });
    return s;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length + 2;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(inline(lines[i].replace(/^&gt;\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
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

async function apiGet<T>(apiBase: string, path: string): Promise<T | { __status: number }> {
  const res = await fetch(`${apiBase}${path}`, { credentials: "include" });
  if (!res.ok) return { __status: res.status };
  return (await res.json()) as T;
}
async function apiSend<T>(
  apiBase: string, path: string, method: "POST" | "PATCH", body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; data: unknown }> {
  const res = await fetch(`${apiBase}${path}`, {
    method, credentials: "include",
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

function staticMapUrl(lat: number, lon: number): string {
  // Free, key-less OSM static tile renderer. We add a marker pin and
  // a 600x300 frame. `<img onerror>` swaps to a plain "View on OSM"
  // link if the service is unreachable.
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=13&size=600x300&maptype=mapnik&markers=${lat},${lon},red-pushpin`;
}

function osmLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
}

function projectHref(p: GalleryProject): string {
  return `/p/?id=${p.project_id}`;
}

// ---------------------------------------------------------------------------
// Listing page
// ---------------------------------------------------------------------------
async function mountList(cfg: BaseConfig): Promise<void> {
  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <h1 class="h2 mb-2">Galleries</h1>
      <p class="text-muted small mb-3">
        Curator-grouped exhibitions. Verified curators can
        <a href="/galleries/new/">create a gallery</a>; everyone else can
        <a href="/briefs/new/?industry=gallery">request curator access</a>.
      </p>
    </header>
    <div id="ga-galleries-list" aria-busy="true">
      <p class="text-muted small">Loading galleries…</p>
    </div>
  `;
  const listEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-galleries-list");
  if (!listEl) return;

  const data = await apiGet<{ galleries: GalleryListItem[] }>(cfg.apiBase, "/v1/galleries");
  if (isErr(data)) {
    listEl.innerHTML = `<p class="text-danger small">Couldn't load galleries (HTTP ${data.__status}).</p>`;
    listEl.removeAttribute("aria-busy");
    return;
  }
  if (data.galleries.length === 0) {
    listEl.innerHTML = `
      <div class="ga-empty text-center py-10">
        <p class="text-muted small mb-3">No galleries yet.</p>
        <a href="/galleries/new/" class="btn btn-accent rounded-0">Create the first gallery</a>
      </div>
    `;
    listEl.removeAttribute("aria-busy");
    return;
  }
  listEl.innerHTML = `<div class="ga-galleries-grid">${data.galleries.map(renderListCard).join("")}</div>`;
  listEl.removeAttribute("aria-busy");
}

function renderListCard(g: GalleryListItem): string {
  const cover = g.cover_url
    ? `<img src="${escapeHtml(g.cover_url)}" alt="" loading="lazy" />`
    : `<span class="ga-gallery-cover-empty">No cover</span>`;
  const range = fmtRange(g.starts_at, g.ends_at);
  const loc = g.location ? escapeHtml(g.location) : "";
  const meta = [loc, range].filter(Boolean).join(" · ");
  const curator = g.curator
    ? `Curated by <a href="/@${escapeHtml(g.curator.handle)}/">@${escapeHtml(g.curator.handle)}</a>`
    : "Uncurated";
  return `
    <a class="ga-gallery-card" href="/galleries/${escapeHtml(g.slug)}/">
      <div class="ga-gallery-cover">${cover}</div>
      <div class="ga-gallery-card-body">
        <h3 class="h5 mb-1">${escapeHtml(g.title)}</h3>
        <p class="ga-gallery-meta">${curator}</p>
        ${meta ? `<p class="ga-gallery-meta text-muted">${meta}</p>` : ""}
        <p class="ga-gallery-meta text-muted">${g.project_count} ${g.project_count === 1 ? "project" : "projects"}</p>
      </div>
    </a>
  `;
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------
async function mountDetail(cfg: BaseConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const slug = (params.get("slug") || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    cfg.rootEl.innerHTML = `<p class="text-danger small">Missing or invalid gallery slug.</p>`;
    return;
  }
  const data = await apiGet<{ gallery: GalleryDetail }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(slug)}`);
  if (isErr(data)) {
    cfg.rootEl.innerHTML = data.__status === 404
      ? `<div class="text-center py-10"><h1 class="h3 mb-3">Gallery not found</h1><p class="text-muted"><a href="/galleries/">All galleries</a></p></div>`
      : `<p class="text-danger small">Couldn't load (HTTP ${data.__status}).</p>`;
    return;
  }

  const g = data.gallery;
  const range = fmtRange(g.starts_at, g.ends_at);
  const cover = g.cover_url
    ? `<img class="ga-gallery-detail-cover" src="${escapeHtml(g.cover_url)}" alt="${escapeHtml(g.title)}" />`
    : "";
  const curatorBlock = g.curator ? `
    <p class="ga-gallery-meta">
      Curated by <a href="/@${escapeHtml(g.curator.handle)}/">${escapeHtml(g.curator.display_name || "@" + g.curator.handle)}</a>
    </p>` : "";

  let physicalBlock = "";
  if (g.location || range) {
    const facts = [g.location ? escapeHtml(g.location) : "", range].filter(Boolean).join(" · ");
    let mapHtml = "";
    if (g.lat !== null && g.lon !== null) {
      const url = staticMapUrl(g.lat, g.lon);
      const fallback = osmLink(g.lat, g.lon);
      mapHtml = `
        <a class="ga-gallery-map" href="${escapeHtml(fallback)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(url)}" alt="Map of ${escapeHtml(g.location || "venue")}"
               onerror="this.parentElement.innerHTML='View on OpenStreetMap ↗';this.parentElement.classList.add('ga-gallery-map-fallback');" />
        </a>`;
    }
    physicalBlock = `
      <section class="ga-gallery-physical mt-4">
        <h2 class="h5 mb-2">Physical show</h2>
        <p class="ga-gallery-meta">${facts}</p>
        ${mapHtml}
      </section>
    `;
  }

  const projectsBlock = g.projects.length === 0
    ? `<p class="text-muted small">No projects in this gallery yet.</p>`
    : `<div class="ga-gallery-projects-grid">
        ${g.projects.map(renderProjectCard).join("")}
      </div>`;

  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <p class="ga-gallery-meta"><a href="/galleries/">← All galleries</a></p>
      <h1 class="h2 mb-2">${escapeHtml(g.title)}</h1>
      ${curatorBlock}
      ${g.description ? `<p class="text-muted">${escapeHtml(g.description)}</p>` : ""}
    </header>
    ${cover}
    <div id="ga-gallery-actions" class="mt-3 d-none">
      <a class="btn btn-sm btn-outline-primary rounded-0" href="/galleries/${escapeHtml(g.slug)}/edit/">Edit gallery</a>
    </div>
    ${g.body_md ? `<section class="ga-gallery-body mt-4"></section>` : ""}
    ${physicalBlock}
    <section class="mt-6">
      <h2 class="h5 mb-3">Projects</h2>
      ${projectsBlock}
    </section>
  `;
  if (g.body_md) {
    const body = cfg.rootEl.querySelector<HTMLDivElement>(".ga-gallery-body")!;
    body.innerHTML = renderMarkdown(g.body_md);
  }

  // Show "Edit" only to the curator. /v1/me 401s for anonymous; treat as not-owner.
  try {
    const me = await apiGet<{ user: { id: number } }>(cfg.apiBase, "/v1/me");
    if (!isErr(me) && g.curator && me.user.id === g.curator.id) {
      cfg.rootEl.querySelector("#ga-gallery-actions")?.classList.remove("d-none");
    }
  } catch { /* not signed in */ }
}

function renderProjectCard(p: GalleryProject): string {
  const cover = p.cover_url
    ? `<img src="${escapeHtml(p.cover_url)}" alt="" loading="lazy" />`
    : `<span class="ga-gallery-project-empty">No capture</span>`;
  return `
    <a class="ga-gallery-project-card" href="${escapeHtml(projectHref(p))}">
      <div class="ga-gallery-project-cover">${cover}</div>
      <div class="ga-gallery-project-body">
        <h3 class="h6 mb-0">${escapeHtml(p.title)}</h3>
        <p class="ga-gallery-meta text-muted">@${escapeHtml(p.owner_handle)}</p>
      </div>
    </a>
  `;
}

// ---------------------------------------------------------------------------
// Shared form for new + edit
// ---------------------------------------------------------------------------
interface FormState {
  title: string;
  description: string;
  bodyMd: string;
  coverUrl: string | null;
  location: string;
  lat: string;
  lon: string;
  startsDate: string; // YYYY-MM-DD
  endsDate: string;
  projects: number[]; // for new: pre-selected; for edit: existing in gallery
}

function dateToInputValue(unix: number | null): string {
  if (!unix) return "";
  try {
    return new Date(unix * 1000).toISOString().slice(0, 10);
  } catch { return ""; }
}

function readForm(cfg: BaseConfig): FormState {
  const get = (sel: string): string => (cfg.rootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.value || "").trim();
  const coverInput = cfg.rootEl.querySelector<HTMLInputElement>("#ga-gallery-cover-url");
  return {
    title: get("#ga-gallery-title"),
    description: get("#ga-gallery-description"),
    bodyMd: get("#ga-gallery-body"),
    coverUrl: (coverInput?.value || "").trim() || null,
    location: get("#ga-gallery-location"),
    lat: get("#ga-gallery-lat"),
    lon: get("#ga-gallery-lon"),
    startsDate: get("#ga-gallery-starts"),
    endsDate: get("#ga-gallery-ends"),
    projects: [],
  };
}

function dateInputToUnix(d: string, endOfDay: boolean): number | null {
  if (!d) return null;
  const t = Date.parse(`${d}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function formPayload(s: FormState): Record<string, unknown> {
  return {
    title: s.title,
    description: s.description || null,
    body_md: s.bodyMd || null,
    cover_url: s.coverUrl,
    location: s.location || null,
    lat: s.lat ? parseFloat(s.lat) : null,
    lon: s.lon ? parseFloat(s.lon) : null,
    starts_at: dateInputToUnix(s.startsDate, false),
    ends_at: dateInputToUnix(s.endsDate, true),
  };
}

function formHtml(initial: Partial<FormState> & { coverPreview?: string | null }, mode: "new" | "edit"): string {
  return `
    <div id="ga-gallery-error" class="alert alert-danger d-none small" role="alert"></div>
    <form id="ga-gallery-form">
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-title">Title</label>
        <input type="text" id="ga-gallery-title" class="form-control rounded-0" maxlength="120" required value="${escapeHtml(initial.title || "")}" />
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-description">Short description</label>
        <input type="text" id="ga-gallery-description" class="form-control rounded-0" maxlength="280" value="${escapeHtml(initial.description || "")}" />
        <p class="form-text small text-muted">One line shown on the listing card.</p>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-body">Body (markdown)</label>
        <textarea id="ga-gallery-body" class="form-control rounded-0" rows="10" maxlength="10000">${escapeHtml(initial.bodyMd || "")}</textarea>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-cover-file">Cover image (PNG, optional)</label>
        <input type="file" id="ga-gallery-cover-file" class="form-control rounded-0" accept="image/png" />
        <input type="hidden" id="ga-gallery-cover-url" value="${escapeHtml(initial.coverUrl || "")}" />
        <div id="ga-gallery-cover-preview" class="mt-2 small text-muted">
          ${initial.coverPreview ? `<img src="${escapeHtml(initial.coverPreview)}" style="max-width:240px;" />` : ""}
        </div>
      </div>
      <fieldset class="mb-4">
        <legend class="h6">Physical show (optional)</legend>
        <div class="mb-3">
          <label class="form-label small" for="ga-gallery-location">Location</label>
          <input type="text" id="ga-gallery-location" class="form-control rounded-0" maxlength="120" placeholder="Geneva, CH" value="${escapeHtml(initial.location || "")}" />
        </div>
        <div class="row gx-3">
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-lat">Latitude</label>
            <input type="text" id="ga-gallery-lat" class="form-control rounded-0" placeholder="46.2044" value="${escapeHtml(initial.lat || "")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-lon">Longitude</label>
            <input type="text" id="ga-gallery-lon" class="form-control rounded-0" placeholder="6.1432" value="${escapeHtml(initial.lon || "")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-starts">Starts</label>
            <input type="date" id="ga-gallery-starts" class="form-control rounded-0" value="${escapeHtml(initial.startsDate || "")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-ends">Ends</label>
            <input type="date" id="ga-gallery-ends" class="form-control rounded-0" value="${escapeHtml(initial.endsDate || "")}" />
          </div>
        </div>
        <p class="form-text small text-muted mb-0">Both lat & lon must be set together. Leave blank to skip the map.</p>
      </fieldset>
      ${mode === "edit" ? `
        <fieldset class="mb-4">
          <legend class="h6">Projects</legend>
          <div id="ga-gallery-current-projects" class="small mb-3"></div>
          <div class="d-flex gap-2 align-items-center">
            <input type="number" min="1" id="ga-gallery-add-id" class="form-control rounded-0" style="max-width:160px;" placeholder="Project id" />
            <button type="button" id="ga-gallery-add-btn" class="btn btn-sm btn-outline-primary rounded-0">Add</button>
          </div>
          <p class="form-text small text-muted">Paste a project id (visible on /p/?id=N). The project must be Published or Minted.</p>
        </fieldset>` : ""}
      <button type="submit" class="btn btn-accent rounded-0" id="ga-gallery-submit">${mode === "new" ? "Create gallery" : "Save changes"}</button>
    </form>
  `;
}

async function uploadCoverFile(apiBase: string, file: File): Promise<string | null> {
  if (!file.type.startsWith("image/png")) return null;
  const buf = await file.arrayBuffer();
  // Convert to base64 in chunks so 5MB files don't blow the stack.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  const res = await apiSend<{ cover: { url: string } }>(apiBase, "/v1/galleries/cover", "POST", { data_url: dataUrl });
  if (!res.ok) return null;
  return res.data.cover.url;
}

function bindCoverInput(cfg: BaseConfig): void {
  const fileInput = cfg.rootEl.querySelector<HTMLInputElement>("#ga-gallery-cover-file");
  const hidden = cfg.rootEl.querySelector<HTMLInputElement>("#ga-gallery-cover-url");
  const preview = cfg.rootEl.querySelector<HTMLDivElement>("#ga-gallery-cover-preview");
  if (!fileInput || !hidden || !preview) return;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    preview.textContent = "Uploading…";
    const url = await uploadCoverFile(cfg.apiBase, file);
    if (!url) {
      preview.innerHTML = `<span class="text-danger">Upload failed (PNG only, ≤5 MB).</span>`;
      return;
    }
    hidden.value = url;
    preview.innerHTML = `<img src="${escapeHtml(url)}" style="max-width:240px;" />`;
  });
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------
async function mountNew(cfg: BaseConfig): Promise<void> {
  const me = await apiGet<{ user: { handle: string; is_curator: number } }>(cfg.apiBase, "/v1/me");
  if (isErr(me)) {
    cfg.rootEl.innerHTML = `
      <div class="text-center py-10">
        <h1 class="h3 mb-3">Sign in to create a gallery.</h1>
        <a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a>
      </div>`;
    return;
  }
  if (!me.user.is_curator) {
    cfg.rootEl.innerHTML = `
      <div class="text-center py-10">
        <h1 class="h3 mb-2">Curator access required</h1>
        <p class="text-muted mb-4">
          Galleries are created by verified curators. Open a brief in the
          <code>gallery</code> industry to request access — we'll flip the
          flag manually for v1.
        </p>
        <a href="/briefs/new/?industry=gallery" class="btn btn-accent rounded-0">Request curator access</a>
      </div>`;
    return;
  }
  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <h1 class="h2 mb-1">New gallery</h1>
      <p class="small text-muted mb-0">
        Curating as <a href="/@${escapeHtml(me.user.handle)}/" class="ga-mono">@${escapeHtml(me.user.handle)}</a>.
        After creating, you can attach projects from the gallery's edit page.
      </p>
    </header>
    ${formHtml({}, "new")}
  `;
  bindCoverInput(cfg);

  const form = cfg.rootEl.querySelector<HTMLFormElement>("#ga-gallery-form")!;
  const errEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-gallery-error")!;
  const submit = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-gallery-submit")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.classList.add("d-none");
    submit.disabled = true;
    const state = readForm(cfg);
    if (!state.title) {
      errEl.textContent = "Title is required."; errEl.classList.remove("d-none"); submit.disabled = false; return;
    }
    const res = await apiSend<{ gallery: { slug: string } }>(cfg.apiBase, "/v1/galleries", "POST", formPayload(state));
    if (!res.ok) {
      const errStr = (res.data && typeof res.data === "object" && "error" in res.data)
        ? String((res.data as { error: unknown }).error) : `HTTP ${res.status}`;
      errEl.textContent = `Couldn't create (${errStr}).`;
      errEl.classList.remove("d-none");
      submit.disabled = false;
      return;
    }
    window.location.href = `/galleries/${res.data.gallery.slug}/edit/`;
  });
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
async function mountEdit(cfg: BaseConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const slug = (params.get("slug") || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    cfg.rootEl.innerHTML = `<p class="text-danger small">Missing or invalid gallery slug.</p>`;
    return;
  }
  const [meRes, galRes] = await Promise.all([
    apiGet<{ user: { id: number; handle: string; is_curator: number } }>(cfg.apiBase, "/v1/me"),
    apiGet<{ gallery: GalleryDetail }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(slug)}`),
  ]);
  if (isErr(meRes)) {
    cfg.rootEl.innerHTML = `<div class="text-center py-10"><h1 class="h3 mb-3">Sign in to edit.</h1><a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a></div>`;
    return;
  }
  if (isErr(galRes)) {
    cfg.rootEl.innerHTML = `<p class="text-danger small">Couldn't load gallery (HTTP ${galRes.__status}).</p>`;
    return;
  }
  const g = galRes.gallery;
  if (!g.curator || g.curator.id !== meRes.user.id) {
    cfg.rootEl.innerHTML = `<div class="text-center py-10"><h1 class="h3 mb-3">Not your gallery</h1><p class="text-muted">Only the curator who created a gallery can edit it.</p></div>`;
    return;
  }

  cfg.rootEl.innerHTML = `
    <header class="mb-4">
      <p class="small mb-2"><a href="/galleries/${escapeHtml(g.slug)}/">← View public page</a></p>
      <h1 class="h2 mb-1">Edit gallery</h1>
    </header>
    ${formHtml({
      title: g.title,
      description: g.description || "",
      bodyMd: g.body_md || "",
      coverUrl: g.cover_url || null,
      location: g.location || "",
      lat: g.lat !== null ? String(g.lat) : "",
      lon: g.lon !== null ? String(g.lon) : "",
      startsDate: dateToInputValue(g.starts_at),
      endsDate: dateToInputValue(g.ends_at),
      coverPreview: g.cover_url || null,
    }, "edit")}
  `;
  bindCoverInput(cfg);
  renderCurrentProjects(cfg, g);

  const form = cfg.rootEl.querySelector<HTMLFormElement>("#ga-gallery-form")!;
  const errEl = cfg.rootEl.querySelector<HTMLDivElement>("#ga-gallery-error")!;
  const submit = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-gallery-submit")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.classList.add("d-none");
    submit.disabled = true;
    const state = readForm(cfg);
    if (!state.title) { errEl.textContent = "Title is required."; errEl.classList.remove("d-none"); submit.disabled = false; return; }
    const res = await apiSend<{ gallery: { slug: string } }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(g.slug)}`, "PATCH", formPayload(state));
    if (!res.ok) {
      const errStr = (res.data && typeof res.data === "object" && "error" in res.data) ? String((res.data as { error: unknown }).error) : `HTTP ${res.status}`;
      errEl.textContent = `Couldn't save (${errStr}).`;
      errEl.classList.remove("d-none");
      submit.disabled = false;
      return;
    }
    submit.textContent = "Saved";
    setTimeout(() => { submit.textContent = "Save changes"; submit.disabled = false; }, 1200);
  });

  // Add-project handler
  const addBtn = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-gallery-add-btn");
  const addInput = cfg.rootEl.querySelector<HTMLInputElement>("#ga-gallery-add-id");
  addBtn?.addEventListener("click", async () => {
    const id = parseInt(addInput?.value || "", 10);
    if (!Number.isFinite(id) || id < 1) return;
    addBtn.disabled = true;
    const res = await apiSend<{ ok: true }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(g.slug)}/projects`, "POST", { project_id: id, action: "add" });
    addBtn.disabled = false;
    if (!res.ok) {
      const errStr = (res.data && typeof res.data === "object" && "error" in res.data) ? String((res.data as { error: unknown }).error) : `HTTP ${res.status}`;
      alert(`Couldn't add: ${errStr}`);
      return;
    }
    if (addInput) addInput.value = "";
    // Reload gallery to refresh project list.
    const fresh = await apiGet<{ gallery: GalleryDetail }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(g.slug)}`);
    if (!isErr(fresh)) renderCurrentProjects(cfg, fresh.gallery);
  });
}

function renderCurrentProjects(cfg: BaseConfig, g: GalleryDetail): void {
  const host = cfg.rootEl.querySelector<HTMLDivElement>("#ga-gallery-current-projects");
  if (!host) return;
  if (g.projects.length === 0) {
    host.innerHTML = `<p class="text-muted small mb-2">No projects yet.</p>`;
    return;
  }
  host.innerHTML = `
    <ul class="list-unstyled mb-2">
      ${g.projects.map(p => `
        <li class="d-flex justify-content-between align-items-center py-1" style="border-bottom: 1px dashed var(--ga-rule);">
          <span>
            <a href="/p/?id=${p.project_id}">${escapeHtml(p.title)}</a>
            <span class="text-muted small">· @${escapeHtml(p.owner_handle)} · #${p.project_id}</span>
          </span>
          <button type="button" class="btn btn-sm btn-link text-danger p-0" data-remove="${p.project_id}">Remove</button>
        </li>`).join("")}
    </ul>
  `;
  host.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt(btn.getAttribute("data-remove") || "", 10);
      if (!id) return;
      btn.disabled = true;
      btn.textContent = "Removing…";
      const res = await apiSend(cfg.apiBase, `/v1/galleries/${encodeURIComponent(g.slug)}/projects`, "POST", { project_id: id, action: "remove" });
      if (!res.ok) { btn.disabled = false; btn.textContent = "Remove"; return; }
      const fresh = await apiGet<{ gallery: GalleryDetail }>(cfg.apiBase, `/v1/galleries/${encodeURIComponent(g.slug)}`);
      if (!isErr(fresh)) renderCurrentProjects(cfg, fresh.gallery);
    });
  });
}

const GAGalleries = {
  mountList,
  mountDetail,
  mountNew,
  mountEdit,
  _renderMarkdown: renderMarkdown,
};

window.GAGalleries = GAGalleries;
export default GAGalleries;
