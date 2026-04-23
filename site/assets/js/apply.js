/**
 * /apply page controller. Walks the user through:
 *   sign-in → existing-application check → form → done.
 */
(function () {
  const root = document.querySelector("[data-ga-apply]");
  if (!root) return;

  const steps = {
    signin: root.querySelector('[data-step="signin"]'),
    existing: root.querySelector('[data-step="existing"]'),
    form: root.querySelector('[data-step="form"]'),
    done: root.querySelector('[data-step="done"]'),
  };
  function show(name) {
    for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
  }

  async function refresh() {
    const user = await window.gaAuth.fetchMe();
    if (!user) return show("signin");
    if (
      user.role === "artist" ||
      user.role === "curator" ||
      user.role === "steward"
    ) {
      // Already an artist — bounce to the studio.
      window.location.replace("/studio/");
      return;
    }
    let app = null;
    try {
      const data = await window.gaAuth.api("/applications/me");
      app = data.application;
    } catch {}
    if (app && (app.status === "pending" || app.status === "approved")) {
      const linkEls = root.querySelectorAll("[data-ga-app-link]");
      linkEls.forEach((a) => (a.href = app.github_url || "#"));
      const issueEl = root.querySelector("[data-ga-app-issue]");
      if (issueEl) issueEl.textContent = app.github_issue || "—";
      const statusEl = root.querySelector("[data-ga-app-status]");
      if (statusEl) statusEl.textContent = app.status;
      const withdraw = root.querySelector("[data-ga-withdraw]");
      if (withdraw) {
        withdraw.hidden = app.status !== "pending";
        withdraw.onclick = async () => {
          if (!confirm("Withdraw your pending application?")) return;
          try {
            await window.gaAuth.api(`/applications/${app.id}/withdraw`, {
              method: "POST",
            });
          } catch {}
          refresh();
        };
      }
      show(app.status === "approved" ? "done" : "existing");
      return;
    }
    show("form");
  }

  const form = root.querySelector("[data-ga-apply-form]");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = form.querySelector("[data-ga-error]");
      errEl.hidden = true;
      const fd = new FormData(form);
      const portfolio_links = String(fd.get("portfolio_links") || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const wallet = String(fd.get("wallet_address") || "").trim();
      const payload = {
        artist_slug: String(fd.get("artist_slug") || "").trim(),
        bio: String(fd.get("bio") || "").trim(),
        portfolio_links,
      };
      if (wallet) payload.wallet_address = wallet;
      try {
        await window.gaAuth.api("/applications", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await refresh();
      } catch (err) {
        errEl.textContent =
          (err.data && err.data.detail) || err.message || "Submission failed.";
        errEl.hidden = false;
      }
    });
  }

  refresh();
})();
