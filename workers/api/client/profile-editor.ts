interface MeUser {
  id: number;
  address: string;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_image: string | null;
  socials: Array<{ label: string; url: string }>;
}

interface MeResponse {
  user: MeUser;
}

interface PatchResponse {
  user: MeUser;
  github_status: { committed: boolean; reason?: string; html_url?: string | null };
}

interface EditorConfig {
  apiBase: string;
  formEl: HTMLElement;
  signedOutEl: HTMLElement;
}

declare global {
  interface Window {
    GAProfileEditor?: typeof GAProfileEditor;
  }
}

function show(el: Element | null) { if (el) el.classList.remove("d-none"); }
function hide(el: Element | null) { if (el) el.classList.add("d-none"); }

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

function renderSocialRow(label = "", url = ""): string {
  return `
    <div class="ga-pf-social">
      <input type="text" class="form-control rounded-0 ga-pf-social-label" maxlength="32" placeholder="label" value="${escapeHtml(label)}" />
      <input type="url" class="form-control rounded-0 ga-pf-social-url" placeholder="https://…" maxlength="500" value="${escapeHtml(url)}" />
      <button type="button" class="ga-pf-remove" aria-label="Remove">×</button>
    </div>
  `;
}

function collectSocials(form: HTMLElement): Array<{ label: string; url: string }> {
  const rows = form.querySelectorAll<HTMLElement>(".ga-pf-social");
  const out: Array<{ label: string; url: string }> = [];
  rows.forEach((row) => {
    const label = row.querySelector<HTMLInputElement>(".ga-pf-social-label")?.value.trim() || "";
    const url = row.querySelector<HTMLInputElement>(".ga-pf-social-url")?.value.trim() || "";
    if (label && url) out.push({ label, url });
  });
  return out;
}

function fillForm(form: HTMLElement, user: MeUser) {
  (form.querySelector("#ga-pf-handle") as HTMLInputElement).value = user.handle;
  (form.querySelector("#ga-pf-display") as HTMLInputElement).value = user.display_name || "";
  (form.querySelector("#ga-pf-bio") as HTMLTextAreaElement).value = user.bio || "";
  (form.querySelector("#ga-pf-avatar") as HTMLInputElement).value = user.avatar_url || "";
  const coverEl = form.querySelector("#ga-pf-cover") as HTMLInputElement | null;
  if (coverEl) coverEl.value = user.cover_image || "";
  const socialsHost = form.querySelector("#ga-pf-socials") as HTMLElement;
  const rows = user.socials.length > 0 ? user.socials : [{ label: "", url: "" }];
  socialsHost.innerHTML = rows.map((s) => renderSocialRow(s.label, s.url)).join("");
  updateBioCount(form);
  updateProfileLinks(user.handle);
}

function updateBioCount(form: HTMLElement) {
  const bio = form.querySelector<HTMLTextAreaElement>("#ga-pf-bio");
  const count = form.querySelector<HTMLElement>("#ga-pf-bio-count");
  if (bio && count) count.textContent = String(bio.value.length);
}

function updateProfileLinks(handle: string) {
  document.querySelectorAll<HTMLAnchorElement>("#ga-profile-link, #ga-pf-view").forEach((a) => {
    a.href = `/@${handle}/`;
    a.textContent = `/@${handle}/`;
  });
}

function attach(cfg: EditorConfig) {
  const form = cfg.formEl.querySelector<HTMLFormElement>("#ga-profile-form")!;
  const errEl = cfg.formEl.querySelector<HTMLElement>("#ga-profile-error")!;
  const okEl = cfg.formEl.querySelector<HTMLElement>("#ga-profile-success")!;

  cfg.formEl.addEventListener("input", (ev) => {
    if ((ev.target as HTMLElement).id === "ga-pf-bio") updateBioCount(cfg.formEl);
  });

  cfg.formEl.querySelector("#ga-pf-add-social")!.addEventListener("click", () => {
    const host = cfg.formEl.querySelector("#ga-pf-socials") as HTMLElement;
    if (host.querySelectorAll(".ga-pf-social").length >= 8) return;
    host.insertAdjacentHTML("beforeend", renderSocialRow());
  });

  cfg.formEl.querySelector("#ga-pf-socials")!.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.classList.contains("ga-pf-remove")) {
      t.closest(".ga-pf-social")?.remove();
    }
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hide(errEl); hide(okEl);

    const handle = (form.querySelector<HTMLInputElement>("#ga-pf-handle")!.value || "").trim().toLowerCase();
    const display = (form.querySelector<HTMLInputElement>("#ga-pf-display")!.value || "").trim();
    const bio = (form.querySelector<HTMLTextAreaElement>("#ga-pf-bio")!.value || "").trim();
    const avatar = (form.querySelector<HTMLInputElement>("#ga-pf-avatar")!.value || "").trim();
    const cover = (form.querySelector<HTMLInputElement>("#ga-pf-cover")?.value || "").trim();
    const socials = collectSocials(form);

    const body: Record<string, unknown> = {
      handle,
      display_name: display || null,
      bio: bio || null,
      avatar_url: avatar || null,
      cover_image: cover || null,
      socials,
    };

    const result = await fetchJson<PatchResponse>(`${cfg.apiBase}/v1/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (isErr(result)) {
      const detail = result.__body && typeof result.__body === "object"
        ? JSON.stringify(result.__body)
        : `HTTP ${result.__status}`;
      errEl.textContent = `Save failed: ${detail}`;
      show(errEl);
      return;
    }

    fillForm(cfg.formEl, result.user);
    const note = result.github_status.committed
      ? `Saved. Static page will refresh on the next build.`
      : `Saved to platform DB. Static page won't update (${escapeHtml(result.github_status.reason || "unknown")}).`;
    okEl.textContent = note;
    show(okEl);
  });
}

const GAProfileEditor = {
  async mount(cfg: EditorConfig) {
    const me = await fetchJson<MeResponse>(`${cfg.apiBase}/v1/me`);
    if (isErr(me)) {
      show(cfg.signedOutEl);
      hide(cfg.formEl);
      return;
    }
    show(cfg.formEl);
    hide(cfg.signedOutEl);
    fillForm(cfg.formEl, me.user);
    attach(cfg);
  },
};

window.GAProfileEditor = GAProfileEditor;
export default GAProfileEditor;
