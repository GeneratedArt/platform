/**
 * $ga — GeneratedArt runtime SDK exposed to every project bundle.
 *
 * Contract (matches fxhash conventions so existing artists feel at home):
 *
 *   $ga.hash       — string, the per-token deterministic hash from the contract
 *   $ga.tokenId    — number, the index of this token within the edition
 *   $ga.rand()     — deterministic PRNG in [0, 1) seeded from $ga.hash
 *   $ga.features   — object the artist fills in to declare on-chain traits
 *   $ga.preview()  — call once when the visual has stabilized; the renderer
 *                    captures a still frame from this point for thumbnails
 *
 * The renderer worker injects the real values via URL params:
 *   ?hash=0x...&token=42&preview=1
 * In local dev (file://, no params) we fall back to a random hash.
 */
(function () {
  const params = new URLSearchParams(self.location.search);
  const fallbackHash =
    "0x" +
    Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("");

  const hash = params.get("hash") || fallbackHash;
  const tokenId = Number(params.get("token") || 0);
  const isPreviewMode = params.get("preview") === "1";

  // Mulberry32 seeded from the first 32 bits of the hash. Deterministic across
  // every browser, every renderer run.
  function seedFromHash(h) {
    const hex = h.replace(/^0x/, "").slice(0, 8).padStart(8, "0");
    return parseInt(hex, 16) >>> 0;
  }
  let state = seedFromHash(hash);
  function rand() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  let previewFired = false;
  function preview() {
    if (previewFired) return;
    previewFired = true;
    self.dispatchEvent(new CustomEvent("ga:preview-ready"));
  }

  self.$ga = {
    hash,
    tokenId,
    isPreviewMode,
    rand,
    features: {},
    preview,
  };
})();
