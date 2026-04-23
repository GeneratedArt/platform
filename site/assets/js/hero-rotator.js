/**
 * Editor's Choice hero rotator (§17.1).
 *
 * Cross-fades through .ga-hero__cell elements every 30s. Pauses when the
 * tab is hidden or when the user has prefers-reduced-motion set (in which
 * case only the first cell ever shows — no surprise motion).
 *
 * The cells are all rendered server-side and stacked absolutely; we only
 * toggle the `is-visible` class. Iframes load lazily on first reveal so the
 * initial paint stays cheap; once loaded they keep rendering in the
 * background, so subsequent fades are instant.
 */
(function () {
  var stage = document.querySelector("[data-ga-hero-stage]");
  if (!stage) return;
  var cells = Array.prototype.slice.call(stage.querySelectorAll(".ga-hero__cell"));
  if (cells.length < 2) return;

  var INTERVAL_MS = 30000;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return; // first cell already has .is-visible from SSR

  var i = 0;
  var timer = null;

  function reveal(idx) {
    var cell = cells[idx];
    // Lazy-mount the iframe on first reveal.
    var ifr = cell.querySelector("iframe[data-src]");
    if (ifr) { ifr.src = ifr.getAttribute("data-src"); ifr.removeAttribute("data-src"); }
    cells.forEach(function (el, j) {
      el.classList.toggle("is-visible", j === idx);
    });
  }

  function step() { i = (i + 1) % cells.length; reveal(i); }
  function start() { if (timer == null) timer = setInterval(step, INTERVAL_MS); }
  function stop()  { if (timer != null) { clearInterval(timer); timer = null; } }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });
  start();
})();
