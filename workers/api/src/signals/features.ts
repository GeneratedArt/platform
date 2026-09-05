/**
 * Feature extraction — the irreversible narrowing step.
 *
 * A signal of arbitrary length becomes a fixed, small set of statistical
 * descriptors. This is where personal data stops being personal data:
 * you cannot reconstruct a night's sleep, a route, or a heartbeat from
 * the aggregates below, and nothing here retains an individual sample.
 *
 * Features serve two purposes downstream:
 *   1. Hashed into the public seed (src/signals/derive.ts).
 *   2. Fed to the generator, so the artwork reflects the data's actual
 *      character rather than an arbitrary number. Descriptors like
 *      `masd` (mean absolute successive difference) and `fragmentation`
 *      exist specifically because they carry the QUALITY of a signal —
 *      a restless night versus a still one — which is what makes a piece
 *      recognisably someone's rather than decorative.
 *
 * Every function here is pure and deterministic: identical input must
 * produce byte-identical output, because the seed depends on it.
 */

import type { Signal } from "./shapes";
import { timestampsOf } from "./shapes";

/**
 * Ordered name/value pairs. An array rather than an object because the
 * canonical encoding for hashing depends on a stable order, and object
 * key order is a weak thing to rely on across engines.
 */
export type Features = { name: string; value: number }[];

const EARTH_RADIUS_M = 6_371_000;

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/** Quantile by linear interpolation on a copy sorted ascending. */
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Mean absolute successive difference — how much the signal moves
 * between neighbouring samples. Two signals can share a mean and a
 * spread while one is smooth and the other jagged; this separates them,
 * and it is the descriptor that carries "irregularity" into the artwork.
 */
function masd(xs: number[]): number {
  if (xs.length < 2) return 0;
  let acc = 0;
  for (let i = 1; i < xs.length; i++) acc += Math.abs(xs[i] - xs[i - 1]);
  return acc / (xs.length - 1);
}

/** Least-squares slope of v against t, per second. */
function slope(ts: number[], vs: number[]): number {
  const n = ts.length;
  if (n < 2) return 0;
  const mt = mean(ts);
  const mv = mean(vs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - mt;
    num += dt * (vs[i] - mv);
    den += dt * dt;
  }
  return den === 0 ? 0 : num / den;
}

/** Shannon entropy in bits over a weight vector; 0 when degenerate. */
function entropy(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const w of weights) {
    if (w <= 0) continue;
    const p = w / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function haversineMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Reduce a signal to its descriptors.
 *
 * Feature NAMES are part of the hashed encoding, so renaming one changes
 * every seed derived after the change. Treat them as a versioned wire
 * format: add new names freely, never rename or reorder existing ones
 * without bumping the salt version.
 */
export function extractFeatures(signal: Signal): Features {
  const ts = timestampsOf(signal);
  const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
  const base: Features = [{ name: "window_seconds", value: span }];

  switch (signal.shape) {
    case "time_series": {
      const vs = signal.samples.map((s) => s.v);
      const times = signal.samples.map((s) => s.t);
      return [
        ...base,
        { name: "count", value: vs.length },
        { name: "mean", value: mean(vs) },
        { name: "sd", value: stdDev(vs) },
        { name: "min", value: Math.min(...vs) },
        { name: "max", value: Math.max(...vs) },
        { name: "p25", value: quantile(vs, 0.25) },
        { name: "median", value: quantile(vs, 0.5) },
        { name: "p75", value: quantile(vs, 0.75) },
        { name: "masd", value: masd(vs) },
        { name: "slope_per_s", value: slope(times, vs) },
      ];
    }

    case "interval_series": {
      const durations = signal.intervals.map((i) => i.end - i.start);
      const total = durations.reduce((a, b) => a + b, 0);
      // Distinct states and how the time divides between them — the
      // shape of a night, without the night.
      const byState = new Map<string, number>();
      for (const i of signal.intervals) {
        byState.set(i.state, (byState.get(i.state) ?? 0) + (i.end - i.start));
      }
      let transitions = 0;
      for (let i = 1; i < signal.intervals.length; i++) {
        if (signal.intervals[i].state !== signal.intervals[i - 1].state) transitions++;
      }
      return [
        ...base,
        { name: "count", value: signal.intervals.length },
        { name: "total_seconds", value: total },
        { name: "mean_seconds", value: mean(durations) },
        { name: "sd_seconds", value: stdDev(durations) },
        { name: "state_count", value: byState.size },
        { name: "transitions", value: transitions },
        // Transitions per hour of covered time: how broken up it was.
        {
          name: "fragmentation",
          value: total > 0 ? transitions / (total / 3600) : 0,
        },
        { name: "state_entropy", value: entropy([...byState.values()]) },
      ];
    }

    case "point_events": {
      const times = [...signal.events.map((e) => e.t)].sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      const meanGap = mean(gaps);
      const sdGap = stdDev(gaps);
      // Distribution across the 24-hour clock — when in the day this
      // person does the thing, with no date attached.
      const hours = new Array<number>(24).fill(0);
      for (const t of times) hours[Math.floor(t / 3600) % 24] += 1;
      return [
        ...base,
        { name: "count", value: times.length },
        { name: "mean_gap_s", value: meanGap },
        { name: "sd_gap_s", value: sdGap },
        // Coefficient of variation of gaps: >1 means bursty, ~0 regular.
        { name: "burstiness", value: meanGap > 0 ? sdGap / meanGap : 0 },
        { name: "hour_entropy", value: entropy(hours) },
      ];
    }

    case "spatial_trace": {
      const pts = signal.points;
      let distance = 0;
      for (let i = 1; i < pts.length; i++) distance += haversineMetres(pts[i - 1], pts[i]);
      const lats = pts.map((p) => p.lat);
      const lons = pts.map((p) => p.lon);
      const straight =
        pts.length > 1 ? haversineMetres(pts[0], pts[pts.length - 1]) : 0;
      const alts = pts.map((p) => p.alt).filter((a): a is number => a !== undefined);
      let gain = 0;
      for (let i = 1; i < alts.length; i++) {
        const d = alts[i] - alts[i - 1];
        if (d > 0) gain += d;
      }
      return [
        ...base,
        { name: "count", value: pts.length },
        { name: "distance_m", value: distance },
        { name: "displacement_m", value: straight },
        // 1 = a straight line, →0 = a wandering loop.
        { name: "straightness", value: distance > 0 ? straight / distance : 0 },
        { name: "mean_speed_ms", value: span > 0 ? distance / span : 0 },
        // Extent only — never the actual coordinates, which would
        // identify a home address.
        { name: "bbox_lat_deg", value: Math.max(...lats) - Math.min(...lats) },
        { name: "bbox_lon_deg", value: Math.max(...lons) - Math.min(...lons) },
        { name: "elevation_gain_m", value: gain },
      ];
    }

    case "categorical": {
      const weights = signal.buckets.map((b) => b.weight);
      const total = weights.reduce((a, b) => a + b, 0);
      const sorted = [...weights].sort((a, b) => b - a);
      const top = sorted[0] ?? 0;
      // Gini: 0 = perfectly even, →1 = one bucket dominates.
      const n = sorted.length;
      let gini = 0;
      if (n > 1 && total > 0) {
        const asc = [...sorted].reverse();
        let weighted = 0;
        for (let i = 0; i < n; i++) weighted += (i + 1) * asc[i];
        gini = (2 * weighted) / (n * total) - (n + 1) / n;
      }
      return [
        ...base,
        { name: "count", value: n },
        { name: "total_weight", value: total },
        { name: "top_share", value: total > 0 ? top / total : 0 },
        { name: "entropy", value: entropy(weights) },
        { name: "gini", value: gini },
      ];
    }
  }
}
