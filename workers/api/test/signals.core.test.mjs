// The signal core: shape validation, feature extraction, seed derivation.
//
// This is the highest-risk code in the data-art pipeline. A malformed
// signal that slips through validation still produces a seed, and a seed
// gets minted — permanently. And the derivation is the only thing
// standing between a published, on-chain value and someone's health
// data, so its irreversibility is a correctness property, not a nicety.

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tmp = mkdtempSync(join(tmpdir(), "ga-signals-"));
const outFile = join(tmp, "signals.mjs");
const entry = join(tmp, "entry.ts");

writeFileSync(
  entry,
  `export { parseSignal, signalWindow, timestampsOf, SIGNAL_SHAPES } from ${JSON.stringify(join(srcDir, "signals", "shapes"))};
export { extractFeatures } from ${JSON.stringify(join(srcDir, "signals", "features"))};
export { deriveSeed, featureDigest, canonicalEncode, SALT_VERSION } from ${JSON.stringify(join(srcDir, "signals", "derive"))};
`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: outFile,
});

const {
  parseSignal,
  signalWindow,
  extractFeatures,
  deriveSeed,
  featureDigest,
  canonicalEncode,
  SIGNAL_SHAPES,
} = await import(pathToFileURL(outFile).href);

const SALT = "test-salt-at-least-16-chars-long";
const T0 = 1_700_000_000;

const hr = {
  shape: "time_series",
  kind: "heart_rate",
  unit: "bpm",
  samples: [
    { t: T0, v: 62 },
    { t: T0 + 60, v: 64 },
    { t: T0 + 120, v: 61 },
    { t: T0 + 180, v: 70 },
  ],
};

const sleep = {
  shape: "interval_series",
  kind: "sleep_stage",
  intervals: [
    { start: T0, end: T0 + 3600, state: "light" },
    { start: T0 + 3600, end: T0 + 7200, state: "deep" },
    { start: T0 + 7200, end: T0 + 9000, state: "rem" },
  ],
};

const plays = {
  shape: "point_events",
  kind: "play_event",
  events: [{ t: T0 }, { t: T0 + 200, label: "track b" }, { t: T0 + 900 }],
};

const run = {
  shape: "spatial_trace",
  kind: "run",
  points: [
    { t: T0, lat: 46.204, lon: 6.143, alt: 375 },
    { t: T0 + 300, lat: 46.21, lon: 6.15, alt: 390 },
    { t: T0 + 600, lat: 46.215, lon: 6.16, alt: 385 },
  ],
};

const genres = {
  shape: "categorical",
  kind: "genre",
  buckets: [
    { label: "ambient", weight: 120 },
    { label: "jazz", weight: 40 },
    { label: "techno", weight: 8 },
  ],
};

const ALL = [hr, sleep, plays, run, genres];

// ---- shape validation ----------------------------------------------------

test("all five shapes are covered by the fixtures", () => {
  assert.deepEqual(
    [...SIGNAL_SHAPES].sort(),
    [...new Set(ALL.map((s) => s.shape))].sort(),
  );
});

test("valid signals of every shape parse", () => {
  for (const s of ALL) {
    const parsed = parseSignal(structuredClone(s));
    assert.equal(parsed.shape, s.shape);
    assert.equal(parsed.kind, s.kind);
  }
});

test("millisecond timestamps are rejected", () => {
  // The classic adapter bug: ms instead of seconds silently yields a
  // window ~50,000 years wide and a meaningless seed.
  assert.throws(
    () => parseSignal({ ...hr, samples: [{ t: T0 * 1000, v: 60 }] }),
    /unix seconds/,
  );
});

test("non-finite values are rejected", () => {
  // JSON.parse admits neither, but an adapter computing a rate can
  // produce both.
  assert.throws(() => parseSignal({ ...hr, samples: [{ t: T0, v: NaN }] }), /finite/);
  assert.throws(
    () => parseSignal({ ...hr, samples: [{ t: T0, v: Infinity }] }),
    /finite/,
  );
});

test("empty signals are rejected", () => {
  for (const s of ALL) {
    const key = { time_series: "samples", interval_series: "intervals", point_events: "events", spatial_trace: "points", categorical: "buckets" }[s.shape];
    assert.throws(() => parseSignal({ ...s, [key]: [] }), /non-empty/);
  }
});

test("reversed or zero-length intervals are rejected rather than sorted", () => {
  assert.throws(
    () => parseSignal({ ...sleep, intervals: [{ start: T0 + 10, end: T0, state: "deep" }] }),
    /after start/,
  );
  assert.throws(
    () => parseSignal({ ...sleep, intervals: [{ start: T0, end: T0, state: "deep" }] }),
    /after start/,
  );
});

test("out-of-range coordinates are rejected", () => {
  assert.throws(
    () => parseSignal({ ...run, points: [{ t: T0, lat: 91, lon: 0 }] }),
    /lat out of range/,
  );
  assert.throws(
    () => parseSignal({ ...run, points: [{ t: T0, lat: 0, lon: -181 }] }),
    /lon out of range/,
  );
});

test("negative categorical weights are rejected", () => {
  assert.throws(
    () => parseSignal({ ...genres, buckets: [{ label: "x", weight: -1 }] }),
    /non-negative/,
  );
});

test("unknown shapes and missing kinds are rejected", () => {
  assert.throws(() => parseSignal({ shape: "spectrogram", kind: "x" }), /unknown signal shape/);
  assert.throws(() => parseSignal({ ...hr, kind: "" }), /kind is required/);
});

test("the window spans first to last sample", () => {
  const w = signalWindow(parseSignal(structuredClone(hr)));
  assert.equal(w.start, T0);
  assert.equal(w.end, T0 + 180);
  assert.equal(w.sampleCount, 4);
});

// ---- features ------------------------------------------------------------

test("feature extraction is deterministic", () => {
  for (const s of ALL) {
    const a = extractFeatures(parseSignal(structuredClone(s)));
    const b = extractFeatures(parseSignal(structuredClone(s)));
    assert.deepEqual(a, b);
  }
});

test("masd separates a jagged signal from a smooth one with the same mean", () => {
  // Two series, identical mean and range, different character. If these
  // produced the same features the artwork could not reflect how the
  // data actually behaved.
  const smooth = parseSignal({
    shape: "time_series", kind: "hr",
    samples: [60, 61, 62, 63, 64, 65].map((v, i) => ({ t: T0 + i * 60, v })),
  });
  const jagged = parseSignal({
    shape: "time_series", kind: "hr",
    samples: [60, 65, 61, 64, 62, 63].map((v, i) => ({ t: T0 + i * 60, v })),
  });
  const f = (x) => Object.fromEntries(extractFeatures(x).map((k) => [k.name, k.value]));
  const a = f(smooth), b = f(jagged);
  assert.equal(a.mean, b.mean);
  assert.ok(b.masd > a.masd * 2, `expected jagged masd >> smooth (${b.masd} vs ${a.masd})`);
});

test("no feature carries a raw sample value through verbatim", () => {
  // Spot-check the intent of the layer: aggregates, not samples.
  const feats = extractFeatures(parseSignal(structuredClone(run)));
  const names = feats.map((f) => f.name);
  for (const n of names) assert.ok(!/lat|lon|coord/.test(n) || /bbox/.test(n), `${n} may leak a coordinate`);
});

// ---- derivation ----------------------------------------------------------

test("canonical encoding is independent of feature order", () => {
  const feats = extractFeatures(parseSignal(structuredClone(hr)));
  const shuffled = [...feats].reverse();
  assert.equal(canonicalEncode(feats), canonicalEncode(shuffled));
});

test("canonical encoding rounds away floating-point noise", () => {
  // The same night parsed on two devices must hash identically; IEEE-754
  // arithmetic differs in the last bits across engines.
  const a = canonicalEncode([{ name: "x", value: 1 / 3 }]);
  const b = canonicalEncode([{ name: "x", value: 0.333333333333 }]);
  assert.equal(a, b);
});

test("canonical encoding rejects duplicate names and non-finite values", () => {
  assert.throws(
    () => canonicalEncode([{ name: "x", value: 1 }, { name: "x", value: 2 }]),
    /duplicate feature/,
  );
  assert.throws(() => canonicalEncode([{ name: "x", value: NaN }]), /not finite/);
  assert.throws(() => canonicalEncode([]), /empty feature set/);
});

test("seed derivation is deterministic", async () => {
  const feats = extractFeatures(parseSignal(structuredClone(sleep)));
  const a = await deriveSeed(feats, SALT);
  const b = await deriveSeed(extractFeatures(parseSignal(structuredClone(sleep))), SALT);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("a near-identical night yields a completely different seed", async () => {
  const base = extractFeatures(parseSignal(structuredClone(sleep)));
  const nudged = parseSignal({
    ...sleep,
    intervals: [
      { start: T0, end: T0 + 3601, state: "light" },
      { start: T0 + 3601, end: T0 + 7200, state: "deep" },
      { start: T0 + 7200, end: T0 + 9000, state: "rem" },
    ],
  });
  const a = await deriveSeed(base, SALT);
  const b = await deriveSeed(extractFeatures(nudged), SALT);
  assert.notEqual(a, b);
});

test("the seed does not leak any feature value", async () => {
  // The seed is published on-chain and pinned to IPFS forever. If a
  // feature were recoverable from it, minting would be permanent
  // publication of health data.
  const feats = extractFeatures(parseSignal(structuredClone(hr)));
  const seed = await deriveSeed(feats, SALT);
  for (const f of feats) {
    const rendered = String(Number(f.value.toFixed(6)));
    const digits = rendered.replace(/[^0-9a-f]/g, "");
    if (digits.length >= 4) {
      assert.ok(!seed.includes(digits), `seed appears to contain feature ${f.name}`);
    }
  }
  assert.ok(!seed.includes(canonicalEncode(feats)));
});

test("changing the salt changes the seed but not the feature digest", async () => {
  // The digest is a commitment a holder can verify without the
  // platform's secret; the seed is salted so a published value cannot be
  // brute-forced back to a plausible feature set.
  const feats = extractFeatures(parseSignal(structuredClone(genres)));
  const s1 = await deriveSeed(feats, SALT);
  const s2 = await deriveSeed(feats, SALT + "-rotated");
  assert.notEqual(s1, s2);

  const d1 = await featureDigest(feats);
  const d2 = await featureDigest(feats);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.notEqual(d1, s1);
});

test("derivation fails closed when the salt is missing or weak", async () => {
  // Failing closed matters more than convenience here: a short salt
  // silently removes the only defence against brute-forcing a seed.
  const feats = extractFeatures(parseSignal(structuredClone(hr)));
  await assert.rejects(() => deriveSeed(feats, ""), /salt is missing or too short/);
  await assert.rejects(() => deriveSeed(feats, "short"), /salt is missing or too short/);
});

test("every shape derives a distinct seed from the others", async () => {
  const seeds = new Set();
  for (const s of ALL) {
    seeds.add(await deriveSeed(extractFeatures(parseSignal(structuredClone(s))), SALT));
  }
  assert.equal(seeds.size, ALL.length);
});
