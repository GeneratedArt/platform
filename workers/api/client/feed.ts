// /feed page + global notifications bell. Both share the same event
// payload shape served by /v1/feed and /v1/notifications. The page
// boots only when its root is on the document; the bell boots from
// any page that includes the nav partial.

interface Actor {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface FeedEvent {
  id: number;
  kind: string;
  actor: Actor;
  target_kind: string | null;
  target_id: number | null;
  payload: Record<string, unknown> | null;
  created_at: number;
  read_at: number | null;
}

interface FeedPayload {
  events: FeedEvent[];
  next_cursor: string | null;
  suggestions: Actor[];
}

interface NotifPayload {
  notifications: FeedEvent[];
  next_cursor: string | null;
  unread: number;
}

declare global {
  interface Window {
    GAAuth?: {
      me(apiBase?: string): Promise<{ user: { id: number; handle: string } } | null>;
    };
  }
}

const PAGE_SIZE = 25;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function actorName(a: Actor): string {
  return a.display_name && a.display_name.trim().length > 0
    ? a.display_name
    : `@${a.handle}`;
}

function actorLink(a: Actor): string {
  return `<a href="/@${encodeURIComponent(a.handle)}/">${escapeHtml(actorName(a))}</a>`;
}

function projectLink(id: number | null, title: string): string {
  if (!id) return escapeHtml(title);
  return `<a href="/p/?id=${id}">${escapeHtml(title)}</a>`;
}

function avatarMarkup(a: Actor): string {
  if (a.avatar_url) {
    return `<img class="ga-feed-avatar" src="${escapeHtml(a.avatar_url)}" alt="" loading="lazy" />`;
  }
  const initials = a.handle.slice(0, 2).toUpperCase();
  return `<span class="ga-feed-avatar ga-feed-avatar-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
}

function deepLinkFor(ev: FeedEvent): string {
  switch (ev.kind) {
    case "follow":
      return `/@${encodeURIComponent(ev.actor.handle)}/`;
    case "brief_posted":
      return ev.target_id ? `/briefs/?id=${ev.target_id}` : "/briefs/";
    case "commit":
    case "freeze":
    case "mint": {
      const pid = ev.payload && typeof ev.payload.project_id === "number"
        ? (ev.payload.project_id as number)
        : ev.target_kind === "project"
          ? ev.target_id
          : null;
      return pid ? `/p/?id=${pid}` : "/explore/";
    }
    default:
      return "/explore/";
  }
}

function renderEvent(ev: FeedEvent): string {
  const who = actorLink(ev.actor);
  const av = avatarMarkup(ev.actor);
  const when = timeAgo(ev.created_at);
  const payload = ev.payload ?? {};
  const title = typeof payload.title === "string" ? payload.title : "";

  let body = "";
  switch (ev.kind) {
    case "commit":
      body = `${who} pushed a new commit to ${projectLink(
        typeof payload.project_id === "number" ? (payload.project_id as number) : ev.target_id,
        title || "a project",
      )}.`;
      break;
    case "freeze":
      body = `${who} froze a new version of ${projectLink(
        typeof payload.project_id === "number" ? (payload.project_id as number) : null,
        title || "a project",
      )}.`;
      break;
    case "mint":
      body = `${who} minted ${projectLink(
        typeof payload.project_id === "number" ? (payload.project_id as number) : ev.target_id,
        title || "a project",
      )}.`;
      break;
    case "follow":
      body = `${who} started following you.`;
      break;
    case "brief_posted":
      body = `${who} posted a brief: ${
        ev.target_id ? `<a href="/briefs/?id=${ev.target_id}">${escapeHtml(title)}</a>` : escapeHtml(title)
      }.`;
      break;
    default:
      body = `${who} did something.`;
  }

  const unreadCls = ev.read_at == null ? " ga-feed-item-unread" : "";
  return `<li class="ga-feed-item${unreadCls}" data-id="${ev.id}" data-kind="${escapeHtml(ev.kind)}">
    <a class="ga-feed-link" href="${escapeHtml(deepLinkFor(ev))}" data-deep-link>
      ${av}
      <div class="ga-feed-body">
        <div class="ga-feed-text">${body}</div>
        <time class="ga-feed-time" datetime="${new Date(ev.created_at * 1000).toISOString()}">${when}</time>
      </div>
    </a>
  </li>`;
}

async function apiFetch<T>(apiBase: string, path: string, init?: RequestInit): Promise<T | null> {
  const r = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`api_${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// /feed page
// ---------------------------------------------------------------------------

async function bootFeedPage(root: HTMLElement) {
  const apiBase = root.dataset.apiBase || "/api";
  const me = await window.GAAuth?.me(apiBase).catch(() => null);
  if (!me?.user) {
    const tpl = document.getElementById("ga-feed-signin-tpl") as HTMLTemplateElement | null;
    root.innerHTML = "";
    if (tpl) root.appendChild(tpl.content.cloneNode(true));
    return;
  }

  let cursor: string | null = null;
  let loading = false;
  const list = document.createElement("ul");
  list.className = "ga-feed-list list-unstyled";
  root.innerHTML = "";
  root.appendChild(list);

  const sentinel = document.createElement("div");
  sentinel.className = "ga-feed-sentinel";
  sentinel.style.minHeight = "1px";
  root.appendChild(sentinel);

  async function loadPage(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) qs.set("cursor", cursor);
      const data = await apiFetch<FeedPayload>(apiBase, `/v1/feed?${qs}`);
      if (!data) return;
      if (data.events.length === 0 && cursor === null) {
        const tpl = document.getElementById("ga-feed-empty-tpl") as HTMLTemplateElement | null;
        root.innerHTML = "";
        if (tpl) root.appendChild(tpl.content.cloneNode(true));
        const sug = root.querySelector<HTMLElement>("[data-suggestions]");
        if (sug) {
          sug.innerHTML = data.suggestions
            .filter((s) => s.handle)
            .map(
              (s) =>
                `<li>${avatarMarkup(s)} <a href="/@${encodeURIComponent(s.handle)}/">${escapeHtml(actorName(s))}</a></li>`,
            )
            .join("");
        }
        return;
      }
      list.insertAdjacentHTML(
        "beforeend",
        data.events.map(renderEvent).join(""),
      );
      cursor = data.next_cursor;
      if (!cursor) {
        sentinel.remove();
        const end = document.createElement("p");
        end.className = "text-muted text-center py-4";
        end.textContent = "You're all caught up.";
        root.appendChild(end);
      }
    } catch (e) {
      console.error("feed load failed", e);
    } finally {
      loading = false;
    }
  }

  // IntersectionObserver-driven infinite scroll. Falls back to a
  // single page on browsers without IO support (none in our matrix
  // but cheap insurance).
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && cursor) loadPage();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(sentinel);
  }
  await loadPage();
}

// ---------------------------------------------------------------------------
// Global notifications bell
// ---------------------------------------------------------------------------

const BELL_ID = "ga-bell";

function buildBell(apiBase: string, unread: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = BELL_ID;
  wrap.className = "ga-bell";
  wrap.dataset.apiBase = apiBase;
  wrap.innerHTML = `
    <button type="button" class="ga-bell-btn" aria-label="Notifications" aria-expanded="false">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      <span class="ga-bell-badge" data-badge ${unread > 0 ? "" : 'hidden'}>${unread > 99 ? "99+" : String(unread)}</span>
    </button>
    <div class="ga-bell-drawer" role="dialog" aria-label="Notifications" hidden>
      <header class="ga-bell-drawer-header">
        <strong>Notifications</strong>
        <button type="button" class="ga-bell-mark-all plain" data-mark-all>Mark all read</button>
      </header>
      <ul class="ga-bell-list list-unstyled" data-list></ul>
      <footer class="ga-bell-drawer-footer">
        <a href="/feed/">Open feed &rarr;</a>
      </footer>
    </div>
  `;
  return wrap;
}

async function bootBell() {
  if (document.getElementById(BELL_ID)) return;
  // Mount target: prefer the .navbar-other ul on nav-10; fall back to body.
  const mountList = document.querySelector<HTMLElement>(".navbar-other .navbar-nav");
  const apiBase = (document.body.dataset.gaApiBase || "/api").trim();

  // Probe auth quietly. Anonymous viewers don't see the bell.
  let me: { user: { id: number; handle: string } } | null = null;
  try {
    me = (await window.GAAuth?.me(apiBase)) ?? null;
  } catch {
    me = null;
  }
  if (!me?.user) return;

  let unread = 0;
  try {
    const probe = await apiFetch<NotifPayload>(apiBase, "/v1/notifications?limit=1");
    if (probe) unread = probe.unread;
  } catch (e) {
    console.error("bell probe failed", e);
  }

  const bell = buildBell(apiBase, unread);
  if (mountList) {
    const li = document.createElement("li");
    li.className = "nav-item ga-bell-host";
    li.appendChild(bell);
    mountList.insertBefore(li, mountList.firstChild);
  } else {
    bell.classList.add("ga-bell-floating");
    document.body.appendChild(bell);
  }

  const btn = bell.querySelector<HTMLButtonElement>(".ga-bell-btn")!;
  const drawer = bell.querySelector<HTMLElement>(".ga-bell-drawer")!;
  const list = bell.querySelector<HTMLElement>("[data-list]")!;
  const badge = bell.querySelector<HTMLElement>("[data-badge]")!;
  const markAll = bell.querySelector<HTMLButtonElement>("[data-mark-all]")!;
  let loaded = false;

  function setUnread(n: number) {
    unread = Math.max(0, n);
    if (unread === 0) {
      badge.hidden = true;
    } else {
      badge.hidden = false;
      badge.textContent = unread > 99 ? "99+" : String(unread);
    }
  }

  async function loadDrawer() {
    list.innerHTML = '<li class="ga-bell-loading text-muted">Loading&hellip;</li>';
    try {
      const data = await apiFetch<NotifPayload>(apiBase, `/v1/notifications?limit=${PAGE_SIZE}`);
      if (!data) {
        list.innerHTML = '<li class="text-muted">Sign-in expired.</li>';
        return;
      }
      if (data.notifications.length === 0) {
        list.innerHTML = '<li class="ga-bell-empty text-muted">No notifications yet.</li>';
      } else {
        list.innerHTML = data.notifications.map(renderEvent).join("");
      }
      setUnread(data.unread);
      loaded = true;
    } catch (e) {
      console.error("notifications load failed", e);
      list.innerHTML = '<li class="text-muted">Couldn\'t load notifications.</li>';
    }
  }

  function close() {
    drawer.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
  function open() {
    drawer.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (!loaded) loadDrawer();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (drawer.hidden) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (drawer.hidden) return;
    if (!bell.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) close();
  });

  // Mark a single row read on click. We don't preventDefault — we
  // want the link to navigate. The fire-and-forget POST runs with
  // keepalive so it survives the page transition.
  list.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-deep-link]");
    if (!link) return;
    const item = link.closest<HTMLElement>(".ga-feed-item");
    if (!item || !item.classList.contains("ga-feed-item-unread")) return;
    const id = parseInt(item.dataset.id || "", 10);
    if (!Number.isFinite(id)) return;
    item.classList.remove("ga-feed-item-unread");
    setUnread(unread - 1);
    fetch(`${apiBase}/v1/notifications/read`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
      keepalive: true,
    }).catch(() => undefined);
  });

  markAll.addEventListener("click", async () => {
    try {
      const r = await apiFetch<{ updated: number; unread: number }>(
        apiBase,
        "/v1/notifications/read",
        { method: "POST", body: JSON.stringify({ all: true }) },
      );
      list.querySelectorAll(".ga-feed-item-unread").forEach((el) => el.classList.remove("ga-feed-item-unread"));
      if (r) setUnread(r.unread);
    } catch (e) {
      console.error("mark all failed", e);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  const root = document.getElementById("ga-feed-root") as HTMLElement | null;
  if (root) bootFeedPage(root);
  bootBell();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
