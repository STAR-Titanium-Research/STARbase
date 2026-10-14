import { describe, expect, it } from 'vitest';
import { inlineSvgPaint, SVG_PAINT } from './exportSvg';

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
