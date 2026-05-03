// /search?q=… — single FTS query, three grouped lists.

interface SearchHitProject {
  kind: "project";
  id: number;
  title: string;
  description: string | null;
  cover_url: string | null;
  status: string;
  owner_handle: string | null;
  rank: number;
}
interface SearchHitArtist {
  kind: "user";
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  rank: number;
}
interface SearchHitBrief {
  kind: "brief";
  id: number;
  title: string;
  body_snippet: string;
  status: string;
  author_handle: string | null;
  rank: number;
}

interface SearchResp {
  q: string;
  kind: string;
  projects: SearchHitProject[];
  artists: SearchHitArtist[];
  briefs: SearchHitBrief[];
}

interface SearchConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

declare global {
  interface Window {
    GASearch?: { mount: (cfg: SearchConfig) => void };
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...args: Parameters<T>) => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms) as unknown as number;
  }) as T;
}

function renderProject(p: SearchHitProject): string {
  return `
    <a class="ga-search-hit" href="/p/?id=${p.id}">
      <h4>${escapeHtml(p.title)}</h4>
      ${p.description ? `<p>${escapeHtml(p.description.slice(0, 160))}</p>` : ""}
      <p class="ga-search-meta">
        ${p.owner_handle ? `@${escapeHtml(p.owner_handle)}` : ""}
        · ${escapeHtml(p.status)}
      </p>
    </a>
  `;
}
function renderArtist(a: SearchHitArtist): string {
  const name = a.display_name || a.handle;
  return `
    <a class="ga-search-hit" href="/@${escapeHtml(a.handle)}/">
      <h4>${escapeHtml(name)}</h4>
      <p class="ga-search-meta">@${escapeHtml(a.handle)}</p>
      ${a.bio ? `<p>${escapeHtml(a.bio.slice(0, 160))}</p>` : ""}
    </a>
  `;
}
function renderBrief(b: SearchHitBrief): string {
  return `
    <a class="ga-search-hit" href="/briefs/${b.id}/">
      <h4>${escapeHtml(b.title)}</h4>
      <p>${escapeHtml(b.body_snippet)}</p>
      <p class="ga-search-meta">brief · ${escapeHtml(b.status)}${
        b.author_handle ? ` · @${escapeHtml(b.author_handle)}` : ""
      }</p>
    </a>
  `;
}

const GASearch = {
  mount(cfg: SearchConfig): void {
    const { apiBase, rootEl: host } = cfg;
    if (!host) return;

    host.innerHTML = `
      <form class="ga-search-form" role="search" autocomplete="off">
        <input id="ga-search-input" type="search" placeholder="Search projects, artists, briefs…"
               class="form-control rounded-0" aria-label="Search query" />
      </form>
      <div class="ga-search-results">
        <section data-group="projects">
          <h3>Projects</h3>
          <div class="ga-search-list" id="ga-search-projects"></div>
        </section>
        <section data-group="artists">
          <h3>Artists</h3>
          <div class="ga-search-list" id="ga-search-artists"></div>
        </section>
        <section data-group="briefs">
          <h3>Briefs</h3>
          <div class="ga-search-list" id="ga-search-briefs"></div>
        </section>
      </div>
      <p class="ga-search-status small text-muted" id="ga-search-status"></p>
    `;
    const input = host.querySelector("#ga-search-input") as HTMLInputElement;
    const projectsEl = host.querySelector("#ga-search-projects") as HTMLElement;
    const artistsEl = host.querySelector("#ga-search-artists") as HTMLElement;
    const briefsEl = host.querySelector("#ga-search-briefs") as HTMLElement;
    const status = host.querySelector("#ga-search-status") as HTMLElement;

    const initialQ = new URLSearchParams(location.search).get("q") || "";
    if (initialQ) {
      input.value = initialQ;
    }

    async function run(q: string): Promise<void> {
      const trimmed = q.trim();
      const nextUrl = new URL(location.href);
      if (trimmed) nextUrl.searchParams.set("q", trimmed);
      else nextUrl.searchParams.delete("q");
      history.replaceState(null, "", nextUrl.toString());
      if (!trimmed) {
        projectsEl.innerHTML = "";
        artistsEl.innerHTML = "";
        briefsEl.innerHTML = "";
        status.textContent = "Type to search.";
        return;
      }
      status.textContent = "Searching…";
      const url = new URL(`${apiBase}/v1/search`);
      url.searchParams.set("q", trimmed);
      try {
        const t0 = performance.now();
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SearchResp;
        const dt = Math.round(performance.now() - t0);
        projectsEl.innerHTML =
          data.projects.length > 0
            ? data.projects.map(renderProject).join("")
            : `<p class="text-muted small">No matching projects.</p>`;
        artistsEl.innerHTML =
          data.artists.length > 0
            ? data.artists.map(renderArtist).join("")
            : `<p class="text-muted small">No matching artists.</p>`;
        briefsEl.innerHTML =
          data.briefs.length > 0
            ? data.briefs.map(renderBrief).join("")
            : `<p class="text-muted small">No matching briefs.</p>`;
        const total = data.projects.length + data.artists.length + data.briefs.length;
        status.textContent = `${total} result${total === 1 ? "" : "s"} in ${dt} ms`;
      } catch (err) {
        status.textContent = `Search failed: ${(err as Error).message}`;
      }
    }

    const debounced = debounce((v: string) => run(v), 200);
    input.addEventListener("input", () => debounced(input.value));
    host.querySelector(".ga-search-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      run(input.value);
    });

    if (initialQ) run(initialQ);
    else status.textContent = "Type to search.";
    input.focus();
  },
};

window.GASearch = GASearch;
export default GASearch;
