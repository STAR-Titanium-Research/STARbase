import { describe, expect, it } from 'vitest';
import { placeCard, type Box } from './placeCard';

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height });
const canvas = box(100, 50, 1000, 600); // on the page at (100, 50)
const card = { width: 300, height: 340 };

describe('placeCard', () => {
  it('goes beside the element, on its right, level with its top', () => {
    const p = placeCard(box(300, 150, 220, 80), canvas, card);
    expect(p.placement).toBe('right');
    expect(p.left).toBe(300 + 220 - 100 + 16);
    expect(p.top).toBe(150 - 50 - 8);
  });

  it('flips to the left when the right does not fit', () => {
    const p = placeCard(box(800, 150, 220, 80), canvas, card);
    expect(p.placement).toBe('left');
    expect(p.left).toBe(800 - 100 - 300 - 16);
  });

  it('goes below when neither side fits', () => {
    const narrow = box(0, 0, 500, 700);
    const p = placeCard(box(100, 100, 400, 80), narrow, card);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(100 + 80 + 10);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 300).toBeLessThanOrEqual(500 - 8);
  });

  it('stays inside the canvas vertically', () => {
    const low = placeCard(box(300, 600, 220, 80), canvas, card);
    expect(low.top + card.height).toBeLessThanOrEqual(600 - 8);
    const high = placeCard(box(300, 40, 220, 80), canvas, card);
    expect(high.top).toBeGreaterThanOrEqual(8);
  });
});
