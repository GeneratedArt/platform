/**
 * /studio page controller. Lists the artist's projects and lets them spin up
 * a new one (which provisions a GitHub repo via the API).
 */
(function () {
  const root = document.querySelector("[data-ga-studio]");
  if (!root) return;

  const gates = {
    "signed-out": root.querySelector('[data-state="signed-out"]'),
    "not-artist": root.querySelector('[data-state="not-artist"]'),
    artist: root.querySelector('[data-state="artist"]'),
  };
  function show(name) {
    for (const [k, el] of Object.entries(gates)) el.hidden = k !== name;
  }

  function renderProjects(list) {
    const ul = root.querySelector("[data-ga-projects]");
    const empty = root.querySelector("[data-ga-empty]");
    ul.querySelectorAll("li:not([data-ga-empty])").forEach((n) => n.remove());
    if (!list.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const p of list) {
      const li = document.createElement("li");
      li.className = "ga-studio__project";
      li.innerHTML = `
        <div>
          <strong>${p.title}</strong>
          <code>/${p.slug}</code>
        </div>
        <span class="ga-pill ga-pill--${p.status}">${p.status}</span>
      `;
      ul.appendChild(li);
    }
  }

  async function loadProjects() {
    try {
      const data = await window.gaAuth.api(`/me/projects`);
      renderProjects(data.projects || []);
    } catch {
      renderProjects([]);
    }
  }

  async function refresh() {
    const user = await window.gaAuth.fetchMe();
    if (!user) return show("signed-out");
    const role = user.role || "collector";
    if (role === "collector") return show("not-artist");
    show("artist");
    const greet = root.querySelector("[data-ga-studio-greeting]");
    if (greet)
      greet.textContent = `Hi ${user.display_name || user.github_login}.`;
    loadProjects();
  }

  // Toggle new-project form
  const toggle = root.querySelector("[data-ga-new-project]");
  const formWrap = root.querySelector("[data-ga-new-form]");
  if (toggle && formWrap) {
    toggle.addEventListener("click", () => {
      formWrap.hidden = !formWrap.hidden;
      if (!formWrap.hidden) formWrap.open = true;
    });
  }

  const form = root.querySelector("[data-ga-project-form]");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = form.querySelector("[data-ga-error]");
      errEl.hidden = true;
      const fd = new FormData(form);
      const payload = {
        title: String(fd.get("title") || "").trim(),
        slug: String(fd.get("slug") || "").trim(),
        description: String(fd.get("description") || "").trim(),
        edition_size: Number(fd.get("edition_size")),
        price_eth: Number(fd.get("price_eth")),
        royalty_bps: Number(fd.get("royalty_bps")),
      };
      try {
        const data = await window.gaAuth.api("/projects", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        alert(
          `Repo created: ${data.html_url}\n\nClone with:\n  git clone ${data.clone_url}`
        );
        form.reset();
        formWrap.hidden = true;
        refresh();
      } catch (err) {
        errEl.textContent =
          (err.data && err.data.detail) || err.message || "Create failed.";
        errEl.hidden = false;
      }
    });
  }

  refresh();
})();
