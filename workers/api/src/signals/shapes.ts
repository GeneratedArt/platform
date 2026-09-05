/**
 * The five normalized signal shapes.
 *
 * Personal data streams are unbounded in variety — a heart rate, a
 * commute, a year of listening, a bank statement — but they are not
 * unbounded in STRUCTURE. Every one reduces to one of the five shapes
 * below. An adapter's entire job is to produce one of these from its
 * source format; feature extraction, seed derivation and the generators
 * see nothing else.
 *
 * That is what keeps "any personal data stream" tractable: adding a
 * source is additive (one adapter), not multiplicative (a new path
 * through every downstream stage).
 *
 * These types describe data IN TRANSIT — in the browser for file
 * imports, or briefly in the Worker for OAuth sources. None of it is
 * ever persisted; see the header of migrations/0021_signal_core.sql.
 */

export const SIGNAL_SHAPES = [
  "time_series",
  "interval_series",
  "point_events",
  "spatial_trace",
  "categorical",
] as const;

export type SignalShape = (typeof SIGNAL_SHAPES)[number];

export function isSignalShape(v: unknown): v is SignalShape {
  return typeof v === "string" && (SIGNAL_SHAPES as readonly string[]).includes(v);
}

/** A scalar sampled over time: heart rate, glucose, steps, spend. */
export interface TimeSeries {
  shape: "time_series";
  kind: string;
  unit?: string;
  /** Unix seconds and value. Need not be evenly spaced. */
  samples: { t: number; v: number }[];
}

/** A state occupying spans: sleep stages, calendar events, trips. */
export interface IntervalSeries {
  shape: "interval_series";
  kind: string;
  intervals: { start: number; end: number; state: string }[];
}

/** Discrete moments: songs played, messages sent, transactions. */
export interface PointEvents {
  shape: "point_events";
  kind: string;
  events: { t: number; label?: string }[];
}

/** A path through the world: a run, a commute, a year of travel. */
export interface SpatialTrace {
  shape: "spatial_trace";
  kind: string;
  points: { t: number; lat: number; lon: number; alt?: number }[];
}

/** A distribution over labels: genres, merchants, contacts. */
export interface Categorical {
  shape: "categorical";
  kind: string;
  buckets: { label: string; weight: number }[];
}

export type Signal =
  | TimeSeries
  | IntervalSeries
  | PointEvents
  | SpatialTrace
  | Categorical;

export class SignalError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/** Finite real number — rejects NaN and ±Infinity, which JSON.parse admits. */
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isUnixSeconds(v: unknown): v is number {
  // Rejects milliseconds passed by mistake, a common adapter bug that
  // would otherwise silently produce a window ~50,000 years wide.
  return isNum(v) && v > 0 && v < 4_102_444_800; // < year 2100
}

function nonEmptyString(v: unknown, max = 120): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/**
 * Validate and narrow an untrusted object to a Signal.
 *
 * Strict on purpose: a malformed signal that slips through produces a
 * seed, and a seed is minted and irreversible. Failing here is cheap;
 * failing later is permanent.
 */
export function parseSignal(input: unknown): Signal {
  if (!input || typeof input !== "object") {
    throw new SignalError("signal must be an object", "invalid_signal");
  }
  const s = input as Record<string, unknown>;
  if (!isSignalShape(s.shape)) {
    throw new SignalError(
      `unknown signal shape: ${String(s.shape)}`,
      "invalid_shape",
    );
  }
  if (!nonEmptyString(s.kind)) {
    throw new SignalError("signal kind is required", "invalid_kind");
  }
  const kind = (s.kind as string).trim();

  switch (s.shape) {
    case "time_series": {
      const samples = requireArray(s.samples, "samples");
      const out = samples.map((raw, i) => {
        const r = asObject(raw, "sample", i);
        if (!isUnixSeconds(r.t)) throw at("sample.t must be unix seconds", "invalid_sample", i);
        if (!isNum(r.v)) throw at("sample.v must be a finite number", "invalid_sample", i);
        return { t: r.t, v: r.v };
      });
      const unit = nonEmptyString(s.unit, 32) ? (s.unit as string) : undefined;
      return { shape: "time_series", kind, unit, samples: out };
    }

    case "interval_series": {
      const intervals = requireArray(s.intervals, "intervals");
      const out = intervals.map((raw, i) => {
        const r = asObject(raw, "interval", i);
        if (!isUnixSeconds(r.start)) throw at("interval.start must be unix seconds", "invalid_interval", i);
        if (!isUnixSeconds(r.end)) throw at("interval.end must be unix seconds", "invalid_interval", i);
        // A zero-length or reversed interval means the adapter mapped the
        // source wrong; silently sorting it would hide that.
        if ((r.end as number) <= (r.start as number)) {
          throw at("interval.end must be after start", "invalid_interval", i);
        }
        if (!nonEmptyString(r.state, 64)) throw at("interval.state is required", "invalid_interval", i);
        return { start: r.start as number, end: r.end as number, state: (r.state as string).trim() };
      });
      return { shape: "interval_series", kind, intervals: out };
    }

    case "point_events": {
      const events = requireArray(s.events, "events");
      const out = events.map((raw, i) => {
        const r = asObject(raw, "event", i);
        if (!isUnixSeconds(r.t)) throw at("event.t must be unix seconds", "invalid_event", i);
        const label = nonEmptyString(r.label, 120) ? (r.label as string).trim() : undefined;
        return { t: r.t as number, label };
      });
      return { shape: "point_events", kind, events: out };
    }

    case "spatial_trace": {
      const points = requireArray(s.points, "points");
      const out = points.map((raw, i) => {
        const r = asObject(raw, "point", i);
        if (!isUnixSeconds(r.t)) throw at("point.t must be unix seconds", "invalid_point", i);
        if (!isNum(r.lat) || r.lat < -90 || r.lat > 90) {
          throw at("point.lat out of range", "invalid_point", i);
        }
        if (!isNum(r.lon) || r.lon < -180 || r.lon > 180) {
          throw at("point.lon out of range", "invalid_point", i);
        }
        const alt = isNum(r.alt) ? r.alt : undefined;
        return { t: r.t as number, lat: r.lat as number, lon: r.lon as number, alt };
      });
      return { shape: "spatial_trace", kind, points: out };
    }

    case "categorical": {
      const buckets = requireArray(s.buckets, "buckets");
      const out = buckets.map((raw, i) => {
        const r = asObject(raw, "bucket", i);
        if (!nonEmptyString(r.label, 120)) throw at("bucket.label is required", "invalid_bucket", i);
        // Negative weight has no meaning in a distribution and would
        // corrupt the normalisation in feature extraction.
        if (!isNum(r.weight) || r.weight < 0) {
          throw at("bucket.weight must be a non-negative number", "invalid_bucket", i);
        }
        return { label: (r.label as string).trim(), weight: r.weight as number };
      });
      return { shape: "categorical", kind, buckets: out };
    }
  }
}

function requireArray(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new SignalError(`${name} must be a non-empty array`, "empty_signal");
  }
  return v;
}

function asObject(v: unknown, name: string, i: number): Record<string, unknown> {
  if (!v || typeof v !== "object") {
    throw new SignalError(`${name}[${i}] must be an object`, "invalid_signal");
  }
  return v as Record<string, unknown>;
}

function at(message: string, code: string, i: number): SignalError {
  return new SignalError(`${message} (index ${i})`, code);
}

/** The window a signal covers, and how densely — for signal_imports. */
export function signalWindow(signal: Signal): {
  start: number;
  end: number;
  sampleCount: number;
} {
  const ts = timestampsOf(signal);
  let start = ts[0];
  let end = ts[0];
  for (const t of ts) {
    if (t < start) start = t;
    if (t > end) end = t;
  }
  return { start, end, sampleCount: ts.length };
}

/** Every timestamp in a signal, in source order. */
export function timestampsOf(signal: Signal): number[] {
  switch (signal.shape) {
    case "time_series":
      return signal.samples.map((s) => s.t);
    case "interval_series":
      // Both edges: an interval's end is as much a moment as its start.
      return signal.intervals.flatMap((i) => [i.start, i.end]);
    case "point_events":
      return signal.events.map((e) => e.t);
    case "spatial_trace":
      return signal.points.map((p) => p.t);
    case "categorical":
      // A distribution has no intrinsic time. Callers supply the window.
      return [];
  }
}
