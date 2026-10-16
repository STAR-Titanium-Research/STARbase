import { describe, expect, it } from 'vitest';
import { inlineSvgPaint, showSvgOverflow, SVG_PAINT } from './exportSvg';

const shape = () => {
  const set: Record<string, string> = {};
  return { set, style: { setProperty: (k: string, v: string) => (set[k] = v) } };
};

describe('inlineSvgPaint', () => {
  it('writes the live shape\'s computed paint onto the copied shape, pairing by position', () => {
    const live = [{ id: 'wire' }, { id: 'hit' }];
    const copy = [shape(), shape()];
    const paint: Record<string, Record<string, string>> = {
      wire: { fill: 'none', stroke: 'color(srgb 0.67 0.35 0.73)', 'stroke-width': '2.4px' },
      hit: { fill: 'none', stroke: 'rgba(0, 0, 0, 0)', 'stroke-width': '14px' },
    };
    inlineSvgPaint({ querySelectorAll: () => live as never }, { querySelectorAll: () => copy }, ((el: { id: string }) => ({ getPropertyValue: (n: string) => paint[el.id][n] ?? '' })) as never);
    expect(copy[0].set).toEqual({ fill: 'none', stroke: 'color(srgb 0.67 0.35 0.73)', 'stroke-width': '2.4px' });
    expect(copy[1].set['stroke-width']).toBe('14px');
  });

  it('carries the striped wire of an unstacked stack: the colour path, then the background core on top of it, each with its own paint', () => {
    const live = [{ id: 'wire' }, { id: 'core' }, { id: 'hit' }];
    const copy = [shape(), shape(), shape()];
    const paint: Record<string, Record<string, string>> = {
      wire: { fill: 'none', stroke: 'rgb(170, 90, 190)', 'stroke-width': '4.2px' },
      core: { fill: 'none', stroke: 'rgb(255, 255, 255)', 'stroke-width': '1.4px' },
      hit: { fill: 'none', stroke: 'rgba(0, 0, 0, 0)', 'stroke-width': '14px' },
    };
    inlineSvgPaint({ querySelectorAll: () => live as never }, { querySelectorAll: () => copy }, ((el: { id: string }) => ({ getPropertyValue: (n: string) => paint[el.id][n] ?? '' })) as never);
    expect(copy.map((c) => [c.set.stroke, c.set['stroke-width']])).toEqual([['rgb(170, 90, 190)', '4.2px'], ['rgb(255, 255, 255)', '1.4px'], ['rgba(0, 0, 0, 0)', '14px']]);
  });

  it('asks for shapes inside an svg only, and stops at the shorter list', () => {
    const asked: string[] = [];
    const copy = [shape()];
    inlineSvgPaint(
      { querySelectorAll: (s) => (asked.push(s), [{}, {}] as never) },
      { querySelectorAll: () => copy },
      (() => ({ getPropertyValue: () => 'x' })) as never,
    );
    expect(asked).toEqual(['svg *']);
    expect(Object.keys(copy[0].set)).toEqual([...SVG_PAINT]);
  });
});

describe('showSvgOverflow', () => {
  it('sets overflow: visible inline on every wire svg of the copy, which is outside .vue-flow, so wires are not clipped at the map\'s origin', () => {
    const svgs = [{ style: { overflow: 'hidden' } }, { style: { overflow: '' } }];
    const asked: string[] = [];
    showSvgOverflow({ querySelectorAll: (s) => (asked.push(s), svgs) });
    expect(asked).toEqual(['svg.vue-flow__edges']);
    expect(svgs.map((s) => s.style.overflow)).toEqual(['visible', 'visible']);
  });
});
