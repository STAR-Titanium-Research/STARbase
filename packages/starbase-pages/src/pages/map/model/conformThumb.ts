// The small trace picture of a Conform run on the Process map (spec "Panels"): wheel speed and Tooling 1 over the run's
// window only, thinned to a few dozen points so the card draws a sparkline, not the log. Pure: a trace in, numbers out.

import { windowRows, type ConformLogRow, type ConformRunRow, type Trace } from '@d1/fast-plotting';

/** The channels the picture shows, in drawing order. */
export const THUMB_KEYS = ['wheel_speed_rpm', 'tooling1_c'] as const;
/** Points per line. */
export const THUMB_POINTS = 96;

export interface ThumbSeries {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** One value per bucket of the window (the mean of its rows); null where the bucket has no reading. */
  values: (number | null)[];
}

export interface ConformThumb {
  /** The run window (epoch ms). */
  startMs: number;
  endMs: number;
  series: ThumbSeries[];
}

/** The dash of each line, by position: the first is solid, the second dashed, so colour is never the only cue (DESIGN 5b). The key draws the same. */
export const TRACE_DASH = ['', '4 3'] as const;

const LABEL: Record<string, string> = { wheel_speed_rpm: 'Wheel speed', tooling1_c: 'Tooling 1' };

/** The mean of each of `points` equal slices of rows [from, to); a slice with no finite reading is null. */
function thin(values: Float64Array, from: number, to: number, points: number): (number | null)[] {
  const rows = to - from;
  const n = Math.min(points, rows);
  const out: (number | null)[] = [];
  for (let b = 0; b < n; b++) {
    const lo = from + Math.floor((b * rows) / n);
    const hi = from + Math.floor(((b + 1) * rows) / n);
    let sum = 0;
    let count = 0;
    for (let i = lo; i < hi; i++) if (Number.isFinite(values[i])) { sum += values[i]; count++; }
    out.push(count ? sum / count : null);
  }
  return out;
}

/**
 * The thumbnail of the run's window, or null when the run has no window yet or the window holds no row of either
 * channel. A log missing one of the channels (an older export) draws the other.
 */
export function conformThumb(trace: Trace, log: Pick<ConformLogRow, 'log_start'>, run: Pick<ConformRunRow, 'window_start' | 'window_end'>, points = THUMB_POINTS): ConformThumb | null {
  if (!run.window_start || !run.window_end) return null;
  const startMs = Date.parse(run.window_start);
  const endMs = Date.parse(run.window_end);
  const logStartMs = Date.parse(log.log_start);
  if (![startMs, endMs, logStartMs].every(Number.isFinite) || !(startMs < endMs)) return null;
  const [from, to] = windowRows(trace, logStartMs, startMs, endMs);
  if (to <= from) return null;
  const series: ThumbSeries[] = [];
  for (const key of THUMB_KEYS) {
    const s = trace.series[key];
    if (!s) continue;
    const values = thin(s.values, from, to, points);
    const finite = values.filter((v): v is number => v !== null);
    if (!finite.length) continue;
    series.push({ key, label: LABEL[key] ?? s.label, unit: s.unit, min: Math.min(...finite), max: Math.max(...finite), values });
  }
  return series.length ? { startMs, endMs, series } : null;
}
