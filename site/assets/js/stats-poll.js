/**
 * Homepage live counters (§17.1).
 *
 * Finds every [data-ga-stat="<key>"] in the page and rewrites its text from
 * GET ${GA_CONFIG.api_base_url}/v1/stats. Polls every 60s while the tab is
 * visible; pauses when hidden to be a polite tenant of D1.
 *
 * Soft-fail: if the API is down, the SSR'd Liquid defaults stay on screen.
 * No layout shift — we only update text inside an already-sized element.
 */
(function () {
  var cfg = window.GA_CONFIG || {};
  var base = cfg.api_base_url || "/api";
  var url  = base.replace(/\/$/, "") + "/v1/stats";

  var nodes = document.querySelectorAll("[data-ga-stat]");
  if (!nodes.length) return;

  var fmt = new Intl.NumberFormat(undefined);
  var INTERVAL_MS = 60000;
  var timer = null;

  function paint(stats) {
    nodes.forEach(function (el) {
      var key = el.getAttribute("data-ga-stat");
      if (key && stats[key] != null) el.textContent = fmt.format(stats[key]);
    });
  }

  function poll() {
    fetch(url, { credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) paint(j); })
      .catch(function () { /* silent — keep the SSR'd numbers */ });
  }

  function start() { if (timer == null) { poll(); timer = setInterval(poll, INTERVAL_MS); } }
  function stop()  { if (timer != null) { clearInterval(timer); timer = null; } }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });
  start();
})();
