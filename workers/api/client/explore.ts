// /explore tab-driven grid + infinite scroll. Three tabs share one
// data shape; the only difference is `tab` and how `next_cursor` is
// interpreted (opaque blob for recent, numeric offset for the others).

interface ExploreCard {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  cover_url: string | null;
  frozen_cid: string | null;
  created_at: number;
  owner: {
    id: number;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
  mint_count: number;
  trend_score: number | null;
}

interface ExploreResp {
  tab: "recent" | "trending" | "featured";
  cards: ExploreCard[];
  next_cursor: string | null;
}

interface ExploreConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

declare global {
  interface Window {
    GAExplore?: { mount: (cfg: ExploreConfig) => void };
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

function timeAgo(ts: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function buildSrcset(coverUrl: string): string {
  // Server returns a /v1/captures/...?w=480 URL. Build retina srcset by
  // swapping the width param for 240/480/800.
  try {
    const u = new URL(coverUrl, location.origin);
    if (!u.pathname.includes("/v1/captures/")) return "";
    const make = (w: number) => {
      u.searchParams.set("w", String(w));
      return `${u.toString()} ${w}w`;
    };
    return [make(240), make(480), make(800)].join(", ");
  } catch {
    return "";
  }
}

function renderCard(c: ExploreCard, apiBase: string): string {
  let cover: string;
  if (c.cover_url) {
    const srcset = buildSrcset(c.cover_url);
    cover = `<img src="${escapeHtml(c.cover_url)}"${
      srcset ? ` srcset="${escapeHtml(srcset)}" sizes="(max-width: 600px) 100vw, 320px"` : ""
    } alt="" loading="lazy" />`;
  } else {
    cover = `<span class="ga-explore-cover-empty">No capture yet</span>`;
  }
  const owner = c.owner.handle
    ? `<a class="ga-explore-author" href="/@${escapeHtml(c.owner.handle)}/">@${escapeHtml(c.owner.handle)}</a>`
    : "";
  const mintBadge =
    c.mint_count > 0
      ? `<span class="ga-explore-mints">${c.mint_count} mint${c.mint_count === 1 ? "" : "s"}</span>`
      : "";
  // Link via /v1/og/projects/:id so URL-bar share copies render rich
  // OG previews on Twitter/Slack/Discord; humans hit a 0-second
  // meta-refresh + JS replace to /p/?id=N.
  const href = `${apiBase}/v1/og/projects/${c.id}`;
  return `
    <a class="ga-explore-card" href="${escapeHtml(href)}">
      <div class="ga-explore-cover">${cover}</div>
      <div class="ga-explore-card-body">
        <h3>${escapeHtml(c.title)}</h3>
        <p class="ga-explore-card-meta">${owner} · ${escapeHtml(timeAgo(c.created_at))}</p>
        ${mintBadge ? `<p class="ga-explore-card-mints">${mintBadge}</p>` : ""}
      </div>
    </a>
  `;
}

const GAExplore = {
  mount(cfg: ExploreConfig): void {
    const { apiBase, rootEl: host } = cfg;
    if (!host) return;

    host.innerHTML = `
      <div class="ga-explore-tabs" role="tablist">
        <button type="button" class="ga-explore-tab is-active" role="tab" data-tab="recent">Recent</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="trending">Trending</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="featured">Featured</button>
      </div>
      <div class="ga-explore-grid" id="ga-explore-grid"></div>
      <div class="ga-explore-status text-center py-6 text-muted small" id="ga-explore-status">Loading…</div>
      <div class="ga-explore-sentinel" aria-hidden="true"></div>
    `;
    const grid = host.querySelector("#ga-explore-grid") as HTMLElement;
    const status = host.querySelector("#ga-explore-status") as HTMLElement;
    const sentinel = host.querySelector(".ga-explore-sentinel") as HTMLElement;
    const tabs = host.querySelectorAll<HTMLButtonElement>(".ga-explore-tab");

    let activeTab: "recent" | "trending" | "featured" = "recent";
    let nextCursor: string | null = null;
    let loading = false;
    let exhausted = false;

    // Allow ?tab=trending in URL to deep-link
    const initialTab = new URLSearchParams(location.search).get("tab");
    if (initialTab === "trending" || initialTab === "featured") {
      activeTab = initialTab;
      tabs.forEach((b) => b.classList.toggle("is-active", b.dataset.tab === activeTab));
    }

    async function loadPage(reset: boolean): Promise<void> {
      if (loading) return;
      if (!reset && exhausted) return;
      loading = true;
      if (reset) {
        grid.innerHTML = "";
        nextCursor = null;
        exhausted = false;
        status.textContent = "Loading…";
      } else {
        status.textContent = "Loading more…";
      }
      const url = new URL(`${apiBase}/v1/explore`);
      url.searchParams.set("tab", activeTab);
      if (nextCursor) url.searchParams.set("cursor", nextCursor);
      try {
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ExploreResp;
        if (data.cards.length === 0 && reset) {
          status.textContent =
            activeTab === "featured"
              ? "No featured projects yet."
              : activeTab === "trending"
                ? "No trending activity yet — check back after a few mints."
                : "No projects yet.";
        } else {
          grid.insertAdjacentHTML("beforeend", data.cards.map((card) => renderCard(card, apiBase)).join(""));
          nextCursor = data.next_cursor;
          if (!nextCursor) {
            exhausted = true;
            status.textContent = grid.children.length === 0 ? status.textContent : "End of feed.";
          } else {
            status.textContent = "";
          }
        }
      } catch (err) {
        status.textContent = `Failed to load (${(err as Error).message}). Tap to retry.`;
        status.style.cursor = "pointer";
        status.onclick = () => {
          status.style.cursor = "";
          status.onclick = null;
          loadPage(reset);
        };
      } finally {
        loading = false;
      }
    }

    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.tab as "recent" | "trending" | "featured";
        if (t === activeTab) return;
        activeTab = t;
        tabs.forEach((b) => b.classList.toggle("is-active", b === btn));
        const nextUrl = new URL(location.href);
        nextUrl.searchParams.set("tab", t);
        history.replaceState(null, "", nextUrl.toString());
        loadPage(true);
      });
    });

    // Infinite scroll: trigger one page ahead of the sentinel.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) loadPage(false);
          }
        },
        { rootMargin: "400px 0px" },
      );
      io.observe(sentinel);
    }

    loadPage(true);
  },
};

window.GAExplore = GAExplore;
export default GAExplore;
