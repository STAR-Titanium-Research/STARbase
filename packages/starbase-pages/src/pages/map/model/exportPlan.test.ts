import { describe, expect, it } from 'vitest';
import { captureFilter, exportPlan, mergeBounds } from './exportPlan';
import type { Kind } from './types';

const base = {
  bounds: { x: 100, y: 50, width: 800, height: 400 },
  kinds: ['sample', 'operation'] as Kind[],
  focus: { kind: 'sample', code: 'S-0001' },
  person: 'Ada Lovelace' as string | null,
  now: new Date(2026, 9, 14, 9, 5),
  format: 'png' as const,
};
const plan = (over: Partial<Parameters<typeof exportPlan>[0]> = {}) => exportPlan({ ...base, ...over });

describe('exportPlan', () => {
  it('names the file after the focus code and the date', () => {
    expect(plan().fileName).toBe('process-map-S-0001-2026-10-14.png');
    expect(plan({ format: 'pdf' }).fileName).toBe('process-map-S-0001-2026-10-14.pdf');
  });

  it('sanitises the focus code to [A-Za-z0-9._-]', () => {
    expect(plan({ focus: { kind: 'sample', code: 'S 0001/α:x' } }).fileName).toBe('process-map-S_0001___x-2026-10-14.png');
  });

  it('writes the two header lines, with the time to the minute', () => {
    expect(plan().header).toEqual(['Sample S-0001 — Process map', 'Exported 2026-10-14 09:05 by Ada Lovelace']);
  });

  it('omits "by …" with no person name', () => {
    expect(plan({ person: null }).header[1]).toBe('Exported 2026-10-14 09:05');
  });

  it('labels a focus kind it does not know from the kind word itself', () => {
    expect(plan({ focus: { kind: 'equipment', code: 'EQ-1' } }).header[0]).toBe('Machine EQ-1 — Process map');
    expect(plan({ focus: { kind: 'mystery', code: 'M-1' } }).header[0]).toBe('Mystery M-1 — Process map');
  });

  it('lists only the kinds present, once each, in the KINDS order', () => {
    const p = plan({ kinds: ['tool', 'sample', 'operation', 'sample', 'junction', 'tool'] });
    expect(p.legend.map((l) => l.kind)).toEqual(['sample', 'operation', 'tool', 'junction']);
    expect(p.legend.map((l) => l.label)).toEqual(['Sample', 'Operation', 'Tool', 'Lineage']);
  });

  it('sizes the picture to the bounds, the padding and the header and legend', () => {
    const p = plan();
    expect(p.padding).toBe(40);
    expect(p.graph).toEqual({ width: 880, height: 480, x: -60, y: -10 });
    expect(p.width).toBe(880);
    expect(p.height).toBe(p.headerHeight + 480 + p.legendHeight);
  });

  it('keeps a small map wide enough for its header and centres it', () => {
    const p = plan({ bounds: { x: 0, y: 0, width: 100, height: 100 } });
    expect(p.width).toBeGreaterThanOrEqual(640);
    expect(p.graph.x).toBe((p.width - 100) / 2);
  });

  it('exports at pixel ratio 2 for a normal map', () => {
    const p = plan();
    expect(p.pixelRatio).toBe(2);
    expect(p.reduced).toBe(false);
    expect(p.screenResolution).toBe(false);
  });

  it('clamps the pixel ratio for a huge map', () => {
    const p = plan({ bounds: { x: 0, y: 0, width: 12000 - 80, height: 9000 - 80 - 200 } });
    expect(p.width).toBe(12000);
    expect(p.pixelRatio).toBeLessThanOrEqual(16384 / p.width);
    expect(p.width * p.pixelRatio * p.height * p.pixelRatio).toBeLessThanOrEqual(268_435_456);
    expect(p.pixelRatio).toBeGreaterThanOrEqual(1);
    expect(p.reduced).toBe(true);
    expect(p.screenResolution).toBe(false);
  });

  it('keeps each side under 16384 px even when the area allows more', () => {
    const p = plan({ bounds: { x: 0, y: 0, width: 9000 - 80, height: 100 } });
    expect(p.width * p.pixelRatio).toBeLessThanOrEqual(16384);
    expect(p.pixelRatio).toBeLessThan(2);
  });

  it('never goes below ratio 1 and says so when even that is too large', () => {
    const p = plan({ bounds: { x: 0, y: 0, width: 20000, height: 20000 } });
    expect(p.pixelRatio).toBe(1);
    expect(p.reduced).toBe(true);
    expect(p.screenResolution).toBe(true);
  });

  it('has no PDF page for a PNG', () => {
    expect(plan().pdf).toBeUndefined();
  });

  it('puts a PDF on A4 landscape, the image inside 10 mm margins keeping its aspect', () => {
    const p = plan({ format: 'pdf' });
    expect(p.pdf?.format).toBe('a4');
    expect(p.pdf?.orientation).toBe('landscape');
    const { x, y, w, h } = p.pdf!.imageBox;
    expect(x).toBeGreaterThanOrEqual(10);
    expect(y).toBeGreaterThanOrEqual(10);
    expect(x + w).toBeLessThanOrEqual(297 - 10 + 1e-9);
    expect(y + h).toBeLessThanOrEqual(210 - 10 + 1e-9);
    expect(w / h).toBeCloseTo(p.width / p.height, 6);
    // centred in the margin box
    expect(x - 10).toBeCloseTo(297 - 10 - (x + w), 6);
    expect(y - 10).toBeCloseTo(210 - 10 - (y + h), 6);
  });

  it('switches to A3 when the picture is wider than 2:1, not at exactly 2:1', () => {
    // width 1200 (plan width = bounds + 80); height = bounds + 80 + chrome. Pick bounds so the ratio is exactly 2, then just over.
    const chrome = plan().headerHeight + plan().legendHeight;
    const at = plan({ format: 'pdf', bounds: { x: 0, y: 0, width: 1200 - 80, height: 600 - 80 - chrome } });
    expect(at.width / at.height).toBe(2);
    expect(at.pdf?.format).toBe('a4');
    const wider = plan({ format: 'pdf', bounds: { x: 0, y: 0, width: 1300 - 80, height: 600 - 80 - chrome } });
    expect(wider.pdf?.format).toBe('a3');
    const { x, y, w, h } = wider.pdf!.imageBox;
    expect(x).toBeGreaterThanOrEqual(10);
    expect(x + w).toBeLessThanOrEqual(420 - 10 + 1e-9);
    expect(y + h).toBeLessThanOrEqual(297 - 10 + 1e-9);
    expect(w / h).toBeCloseTo(wider.width / wider.height, 6);
  });
});

describe('mergeBounds', () => {
  it('is the box round all the boxes', () => {
    expect(mergeBounds([{ x: 10, y: 20, width: 5, height: 5 }, { x: -4, y: 0, width: 4, height: 100 }])).toEqual({ x: -4, y: 0, width: 19, height: 100 });
  });
  it('is null for none', () => {
    expect(mergeBounds([])).toBeNull();
  });
});

describe('captureFilter', () => {
  const el = (selector: string) => ({ matches: (s: string) => s.split(',').map((x) => x.trim()).includes(selector) }) as unknown as Element;
  it('keeps the graph', () => {
    expect(captureFilter(el('.vue-flow__node'))).toBe(true);
    expect(captureFilter(el('.vue-flow__edge'))).toBe(true);
  });
  it('drops the hover card, wire tip, controls, minimap and notices', () => {
    for (const s of ['.hover-card', '.wire-tip', '.vue-flow__controls', '.vue-flow__minimap', '.pm-banner']) expect(captureFilter(el(s))).toBe(false);
  });
  it('keeps text nodes, which have no matches()', () => {
    expect(captureFilter({} as unknown as Element)).toBe(true);
  });
});
