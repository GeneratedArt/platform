// Tiny health-check widget. Calls <api_base_url>/health and updates the dot.
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.querySelector(".api-status");
    if (!el) return;
    el.hidden = false;
    var base = el.getAttribute("data-api-base");
    var dot = el.querySelector(".api-status__dot");
    var label = el.querySelector(".api-status__label");
    fetch(base.replace(/\/$/, "") + "/health", { mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (j) {
        dot && (dot.style.background = j.db === "ok" ? "#3ddc84" : "#f5a623");
        label && (label.textContent = "API ok");
      })
      .catch(function () {
        dot && (dot.style.background = "#888");
        label && (label.textContent = "API offline");
      });
  });
})();
