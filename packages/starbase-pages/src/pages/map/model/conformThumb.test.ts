import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTrace, resetTraceCache, type SeriesMeta } from '@d1/fast-plotting';
import type { HostApi } from '@d1/ui';
import { conformThumb, THUMB_KEYS } from './conformThumb';
import { conformThumbs, dataPreview, type DataPreview } from './dataPreview';
import type { Ref } from './types';

const LOG_START = '2025-03-17T13:00:00.000Z';
const at = (s: number) => new Date(Date.parse(LOG_START) + s * 1000).toISOString();

const SERIES: SeriesMeta[] = [
  { key: 'wheel_speed_rpm', label: 'Wheel speed', unit: 'rpm', group: 'speed', min: 0, max: 5 },
  { key: 'motor_torque_pct', label: 'Motor torque', unit: '%', group: 'torque', min: 0, max: 40 },
  { key: 'tooling1_c', label: 'Tooling 1 (behind abutment)', unit: '°C', group: 'temp', min: 100, max: 160 },
];

/** 600 rows at 1 Hz: the wheel stands for 300 s then turns at 5 rpm; Tooling 1 warms by 0.1 °C a second. */
function csv(rows = 600, series = SERIES): string {
  const lines = ['time_s,' + series.map((s) => s.key).join(',')];
  for (let t = 0; t < rows; t++) {
    const value: Record<string, number> = { wheel_speed_rpm: t < 300 ? 0 : 5, motor_torque_pct: t < 300 ? 0 : 30, tooling1_c: 100 + t * 0.1 };
    lines.push([t, ...series.map((s) => value[s.key])].join(','));
  }
  return lines.join('\n') + '\n';
}

const LOG = { log_start: LOG_START };

describe('conformThumb', () => {
  const trace = parseTrace(csv(), SERIES);

  it('draws wheel speed and Tooling 1, in that order, over the run window only', () => {
    const t = conformThumb(trace, LOG, { window_start: at(300), window_end: at(540) })!;
    expect(t.series.map((s) => s.key)).toEqual([...THUMB_KEYS]);
    expect(t.series.map((s) => s.key)).toEqual(['wheel_speed_rpm', 'tooling1_c']);
    expect(t.startMs).toBe(Date.parse(at(300)));
    const [speed, tooling] = t.series;
    // The window starts after the standstill: the speed line is flat at 5 rpm all along.
    expect([speed.min, speed.max]).toEqual([5, 5]);
    // Tooling 1 only spans the window (130.0 to 153.9), not the 100 to 159.9 of the whole log.
    expect(tooling.min).toBeGreaterThanOrEqual(130);
    expect(tooling.max).toBeLessThanOrEqual(153.9 + 1e-9);
    expect(tooling.max).toBeGreaterThan(150);
    expect(speed.values.length).toBeLessThanOrEqual(96);
    expect(speed.values.every((v) => v === 5)).toBe(true);
  });

  it('thins a window to the point budget, and keeps every row of a short one', () => {
    expect(conformThumb(trace, LOG, { window_start: at(0), window_end: at(600) }, 24)!.series[0].values).toHaveLength(24);
    expect(conformThumb(trace, LOG, { window_start: at(300), window_end: at(310) })!.series[0].values).toHaveLength(10);
  });

  it('has no picture for a run with no window, an empty one, or a window outside the log', () => {
    expect(conformThumb(trace, LOG, { window_start: null, window_end: null })).toBeNull();
    expect(conformThumb(trace, LOG, { window_start: at(100), window_end: at(100) })).toBeNull();
    expect(conformThumb(trace, LOG, { window_start: at(900), window_end: at(1000) })).toBeNull();
  });

  it('draws the channel that is there when a log lacks the other (an older export)', () => {
    const only = SERIES.filter((s) => s.key === 'tooling1_c');
    const t = conformThumb(parseTrace(csv(600, only), only), LOG, { window_start: at(0), window_end: at(600) })!;
    expect(t.series.map((s) => s.key)).toEqual(['tooling1_c']);
  });
});

const op = (id: string): Ref => ({ collection: 'manufacturing_operations', id, code: `CF-${id}` });

/** An api for one Conform run `c1` (window 13:05 to 13:09) on log `log-thumb`; `readable: false` hides the log (403). */
function fakeApi({ readable = true, withWindow = true, file = 200 } = {}) {
  const get = vi.fn(async (path: string, _config?: unknown) => {
    if (path === '/items/conform_run_data') {
      return { data: { data: [{ id: 'r1', operation_id: 'c1', log_id: 'log-thumb', window_start: withWindow ? at(300) : null, window_end: withWindow ? at(540) : null, status: withWindow ? 'done' : 'no_window' }] } };
    }
    if (path === '/items/conform_logs/log-thumb') {
      if (!readable) throw Object.assign(new Error('HTTP 403'), { response: { status: 403 } });
      return { data: { data: { log_id: 'log-thumb', directus_files_id: 'file-1', log_start: LOG_START, log_end: at(599), n_rows: 600, duration_s: 599, series: SERIES } } };
    }
    if (path === '/assets/file-1') {
      if (file !== 200) throw Object.assign(new Error(`HTTP ${file}`), { response: { status: file } });
      return { data: csv() };
    }
    return { data: { data: [] } };
  });
  return { api: { get } as unknown as HostApi, get };
}

describe('conformThumbs', () => {
  beforeEach(() => resetTraceCache());   // the trace cache is shared by the whole module
  const preview = (over: Partial<DataPreview> = {}): Record<string, DataPreview> => ({ c1: { kind: 'conform', plotterPath: '/d1-conform-dashboard?operation=c1', ...over }, f1: { kind: 'fast', plotterPath: '/x' } });

  it('reads the window trace of each Conform run, and only of those', async () => {
    const { api, get } = fakeApi();
    const out = await conformThumbs(api, preview());
    expect(Object.keys(out)).toEqual(['c1']);
    expect(out.c1.thumb!.series.map((s) => s.key)).toEqual(['wheel_speed_rpm', 'tooling1_c']);
    expect(out.c1.note).toBeUndefined();
    expect(get.mock.calls.map((c) => c[0])).toContain('/assets/file-1');
  });

  it('leaves a run alone that has its thumbnail already', async () => {
    const { api, get } = fakeApi();
    expect(await conformThumbs(api, preview({ thumb: { startMs: 0, endMs: 1, series: [] } }))).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('gives no picture when the run has no window, and never throws', async () => {
    expect(await conformThumbs(fakeApi({ withWindow: false }).api, preview())).toEqual({});
  });

  it('says the log is not visible when the log row or its file is forbidden', async () => {
    expect(await conformThumbs(fakeApi({ readable: false }).api, preview())).toEqual({ c1: { note: 'Conform log not visible to you' } });
    expect(await conformThumbs(fakeApi({ file: 403 }).api, preview())).toEqual({ c1: { note: 'Conform log not visible to you' } });
  });

  it('says it could not load the log for any other failure', async () => {
    expect(await conformThumbs(fakeApi({ file: 500 }).api, preview())).toEqual({ c1: { note: 'Could not load the Conform log' } });
  });

  it('downloads one log once when several runs on it ask at the same time', async () => {
    const { api, get } = fakeApi();
    const two: Record<string, DataPreview> = { c1: { kind: 'conform', plotterPath: '/x' }, c2: { kind: 'conform', plotterPath: '/y' } };
    await conformThumbs(api, two);
    expect(get.mock.calls.filter((c) => c[0] === '/assets/file-1')).toHaveLength(1);
  });
});

describe('dataPreview of a Conform run', () => {
  it('is kind conform with the Conform plotter path when the run has a log, and reads no file', async () => {
    const get = vi.fn(async (path: string) => ({ data: { data: path === '/items/conform_run_data' ? [{ operation_id: 'c1' }] : [] } }));
    const out = await dataPreview({ get } as unknown as HostApi, [op('c1'), op('x')]);
    expect(out.c1).toEqual({ kind: 'conform', plotterPath: '/d1-conform-dashboard?operation=c1' });
    expect(out.x.kind).toBe('none');
    for (const [path] of get.mock.calls) expect(String(path)).not.toContain('/assets/');
  });

  it('a refused Conform read leaves the other kinds standing', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/items/conform_run_data') throw Object.assign(new Error('HTTP 403'), { response: { status: 403 } });
      return { data: { data: path === '/items/fast_run_data' ? [{ operation_id: 'b' }] : [] } };
    });
    const out = await dataPreview({ get } as unknown as HostApi, [op('c1'), op('b')]);
    expect(out.c1.kind).toBe('none');
    expect(out.b.kind).toBe('fast');
  });
});
