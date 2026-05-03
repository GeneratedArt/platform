interface PublicUser {
  id: number;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_image: string | null;
  socials: Array<{ label: string; url: string }>;
  created_at: number;
}

interface ProfileResponse {
  user: PublicUser;
  counts: { followers: number; following: number };
  is_self?: boolean;
  is_following?: boolean;
}

interface ProjectSummary {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  engine: string;
  status: string;
  cover_url: string | null;
  updated_at: number;
}

interface ProfileConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

declare global {
  interface Window {
    GAProfile?: typeof GAProfile;
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | { __status: number; __body: unknown }> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch {}
    return { __status: res.status, __body: body };
  }
  return (await res.json()) as T;
}

function isErr<T>(v: T | { __status: number; __body: unknown }): v is { __status: number; __body: unknown } {
  return typeof v === "object" && v !== null && "__status" in (v as Record<string, unknown>);
}

function projectCard(p: ProjectSummary): string {
  const cover = p.cover_url
    ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy" />`
    : `<span class="ga-profile-card-cover-empty">${escapeHtml(p.engine)}</span>`;
  return `
    <a class="ga-profile-card" href="/p/${p.id}/">
      <div class="ga-profile-card-cover">${cover}</div>
      <div class="ga-profile-card-body">
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.engine)} · ${escapeHtml(p.status)}</p>
      </div>
    </a>
  `;
}

function setText(root: HTMLElement, sel: string, text: string) {
  const el = root.querySelector<HTMLElement>(sel);
  if (el) el.textContent = text;
}

function show(el: Element | null) { if (el) el.classList.remove("d-none"); }
function hide(el: Element | null) { if (el) el.classList.add("d-none"); }

async function hydrateProfile(cfg: ProfileConfig, handle: string) {
  const profileResult = await fetchJson<ProfileResponse>(
    `${cfg.apiBase}/v1/users/${encodeURIComponent(handle)}`,
  );

  const followBtn = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-follow-btn");
  const editLink = cfg.rootEl.querySelector<HTMLAnchorElement>("#ga-edit-profile");
  const connectCta = cfg.rootEl.querySelector<HTMLAnchorElement>("#ga-connect-cta");
  const statusEl = cfg.rootEl.querySelector<HTMLElement>("#ga-follow-status");

  if (isErr(profileResult)) {
    if (statusEl) {
      statusEl.textContent = profileResult.__status === 404
        ? "This profile hasn't been claimed yet. Counts and projects will appear once the artist signs in."
        : "Couldn't reach the platform API.";
    }
    return null;
  }

  setText(cfg.rootEl, "#ga-profile-followers-count", String(profileResult.counts.followers));
  setText(cfg.rootEl, "#ga-profile-following-count", String(profileResult.counts.following));

  if (profileResult.is_self === true) {
    show(editLink);
    if (followBtn) followBtn.dataset.gaState = "self";
  } else if (profileResult.is_self === false) {
    show(followBtn);
    if (followBtn) {
      setFollowState(followBtn, !!profileResult.is_following);
    }
  } else {
    // Anonymous viewer (no `is_self` key in response).
    show(connectCta);
  }

  return profileResult;
}

async function loadProjects(cfg: ProfileConfig, handle: string) {
  const grid = cfg.rootEl.querySelector<HTMLElement>("#ga-profile-projects");
  if (!grid) return;
  const result = await fetchJson<{ projects: ProjectSummary[] }>(
    `${cfg.apiBase}/v1/users/${encodeURIComponent(handle)}/projects`,
  );
  if (isErr(result)) {
    grid.innerHTML = `<div class="ga-profile-empty">Couldn't load projects.</div>`;
    setText(cfg.rootEl, "#ga-profile-projects-count", "0");
    return;
  }
  // Hide archived from public profile view; the artist sees them in /dashboard.
  const visible = result.projects.filter((p) => p.status !== "archived");
  setText(cfg.rootEl, "#ga-profile-projects-count", String(visible.length));
  if (!visible.length) {
    grid.innerHTML = `<div class="ga-profile-empty">No published projects yet.</div>`;
    return;
  }
  grid.innerHTML = visible.map(projectCard).join("");
}

function setFollowState(btn: HTMLButtonElement, following: boolean) {
  btn.dataset.gaState = following ? "following" : "not-following";
  btn.textContent = following ? "Following" : "Follow";
  if (following) {
    btn.classList.remove("btn-accent");
    btn.classList.add("btn-outline-primary");
  } else {
    btn.classList.remove("btn-outline-primary");
    btn.classList.add("btn-accent");
  }
}

function attachFollowToggle(cfg: ProfileConfig, handle: string) {
  const btn = cfg.rootEl.querySelector<HTMLButtonElement>("#ga-follow-btn");
  if (!btn) return;
  const countEl = cfg.rootEl.querySelector<HTMLElement>("#ga-profile-followers-count");
  const statusEl = cfg.rootEl.querySelector<HTMLElement>("#ga-follow-status");

  btn.addEventListener("click", async () => {
    if (btn.dataset.gaState === "self") return;
    if (btn.dataset.gaPending === "1") return;

    // Optimistic flip: update button + follower count immediately, then
    // POST/DELETE in the background. On failure, revert the UI to the
    // pre-click state and surface the reason in the status region.
    const wasFollowing = btn.dataset.gaState === "following";
    const willFollow = !wasFollowing;
    const prevCountText = countEl?.textContent ?? "0";
    const prevCount = parseInt(prevCountText, 10) || 0;
    const optimisticCount = willFollow ? prevCount + 1 : Math.max(0, prevCount - 1);

    btn.dataset.gaPending = "1";
    setFollowState(btn, willFollow);
    if (countEl) countEl.textContent = String(optimisticCount);
    if (statusEl) statusEl.textContent = "";

    const result = await fetchJson<{ is_following: boolean; counts: { followers: number; following: number } }>(
      `${cfg.apiBase}/v1/users/${encodeURIComponent(handle)}/follow`,
      { method: willFollow ? "POST" : "DELETE" },
    );
    btn.dataset.gaPending = "";

    if (isErr(result)) {
      setFollowState(btn, wasFollowing);
      if (countEl) countEl.textContent = prevCountText;
      if (statusEl) {
        statusEl.textContent =
          result.__status === 401
            ? "Sign in to follow artists."
            : `Follow failed (${result.__status}). Try again in a moment.`;
      }
      return;
    }

    // Reconcile with the server's authoritative count (covers races
    // where another tab or device also followed/unfollowed).
    setFollowState(btn, result.is_following);
    if (countEl) countEl.textContent = String(result.counts.followers);
  });
}

const GAProfile = {
  async mount(cfg: ProfileConfig) {
    const handle = (cfg.rootEl.dataset.handle || "").toLowerCase();
    if (!handle) return;
    await Promise.all([
      hydrateProfile(cfg, handle),
      loadProjects(cfg, handle),
    ]);
    attachFollowToggle(cfg, handle);
  },
};

window.GAProfile = GAProfile;
export default GAProfile;
