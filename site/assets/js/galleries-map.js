(function () {
  "use strict";

  function init() {
    if (typeof L === "undefined") return; // Leaflet not loaded
    var mapEl = document.getElementById("ga-map");
    var dataEl = document.getElementById("ga-map-data");
    if (!mapEl || !dataEl) return;

    var galleries;
    try { galleries = JSON.parse(dataEl.textContent || "[]"); }
    catch (e) { console.warn("ga-map: invalid data", e); return; }
    if (!galleries.length) {
      mapEl.innerHTML = '<p class="ga-muted" style="padding:2rem">No galleries with coordinates yet.</p>';
      return;
    }

    var TILES = {
      light: {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      },
      dark: {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}{r}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }
    };

    var map = L.map(mapEl, {
      scrollWheelZoom: false,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true
    }).setView([20, 10], 2);

    function currentTheme() {
      return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    }

    var tileLayer = L.tileLayer(TILES[currentTheme()].url, {
      maxZoom: 18, subdomains: "abcd", attribution: TILES[currentTheme()].attribution
    }).addTo(map);

    function swapTiles() {
      var t = TILES[currentTheme()];
      tileLayer.setUrl(t.url);
    }

    // Re-tile on theme toggle (the toggle in genart-footer.html mutates data-theme).
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === "data-theme") swapTiles();
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function pinIcon(status) {
      var color = status === "flagship"
        ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e63a17"
        : "#9ca0a8";
      var size = status === "flagship" ? 18 : 12;
      var html = '<span class="ga-map-pin" style="--pin-color:' + color + ';--pin-size:' + size + 'px"></span>';
      return L.divIcon({
        className: "ga-map-pin-wrap",
        html: html,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2]
      });
    }

    var markers = [];
    galleries.forEach(function (g) {
      var marker = L.marker([g.lat, g.lng], { icon: pinIcon(g.status), title: g.name });
      var loc = [g.city, g.country].filter(Boolean).join(", ");
      var statusBadge = g.status === "flagship"
        ? '<span class="ga-map-badge ga-map-badge--flagship">Flagship</span>'
        : '<span class="ga-map-badge">Partner</span>';
      marker.bindPopup(
        '<div class="ga-map-pop">' +
          '<div class="ga-map-pop__head">' + statusBadge + '<span class="ga-map-pop__city">' + esc(loc) + '</span></div>' +
          '<h3 class="ga-map-pop__name"><a href="' + esc(g.url) + '">' + esc(g.name) + '</a></h3>' +
          (g.tagline ? '<p class="ga-map-pop__tag">' + esc(g.tagline) + '</p>' : '') +
        '</div>',
        { closeButton: false, maxWidth: 260 }
      );
      marker.addTo(map);
      markers.push(marker);
    });

    var group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 5, animate: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
