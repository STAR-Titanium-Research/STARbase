import { describe, expect, it } from 'vitest';
import { placeMerged, type Box } from './placeMerged';

const size = { width: 100, height: 40 };
const sizes = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, size]));
const box = (x: number, y: number): Box => ({ x, y, ...size });
const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x < b.x + 100 && b.x < a.x + 100 && a.y < b.y + 40 && b.y < a.y + 40;

describe('placeMerged (spec 6.7)', () => {
  it('leaves every placed card where it is, a dragged one included, and returns only the new ones', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 400, y: 0 } },
      sizes: sizes('a', 'b', 'c'),
      placed: { a: box(500, 300), b: box(700, 300) }, // both dragged far from ELK's idea
      edges: [{ from: 'b', to: 'c' }],
      dir: 'RIGHT',
      anchors: ['b'],
    });
    expect(Object.keys(out)).toEqual(['c']);
  });

  it('lines a new card up with the placed card it is wired to', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, c: { x: 200, y: 0 } },
      sizes: sizes('a', 'c'),
      placed: { a: box(500, 300) },
      edges: [{ from: 'a', to: 'c' }],
      dir: 'RIGHT',
    });
    expect(out.c).toEqual({ x: 700, y: 300 });
  });

  it('never puts a new card on top of anything: it steps past what it lies on', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, c: { x: 0, y: 0 }, d: { x: 0, y: 0 } },
      sizes: sizes('a', 'c', 'd'),
      placed: { a: box(0, 0) },
      edges: [{ from: 'a', to: 'c' }, { from: 'a', to: 'd' }],
      dir: 'RIGHT',
    });
    const all = [{ x: 0, y: 0 }, out.c, out.d];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j])).toBe(false);
    expect(out.c.y).toBeGreaterThan(0);
    expect(out.d.y).toBeGreaterThan(out.c.y);
  });

  it('puts a group wired to nothing placed beside the card that was expanded, keeping its own arrangement', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, root: { x: 0, y: 0 }, i0: { x: 200, y: 0 }, i1: { x: 200, y: 80 } },
      sizes: sizes('a', 'root', 'i0', 'i1'),
      placed: { a: box(300, 200) },
      edges: [{ from: 'root', to: 'i0' }, { from: 'root', to: 'i1' }],
      dir: 'RIGHT',
      anchors: ['a'],
    });
    expect(out.root.x).toBeGreaterThan(400); // right of the anchor (x 300 + 100)
    expect(out.root.y).toBe(200);
    expect(out.i0.x - out.root.x).toBe(200);
    expect(out.i1.y - out.i0.y).toBe(80);
  });

  it('two expands in one layout: each group of new cards goes beside the expanded card nearest to it', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, b: { x: 0, y: 1000 }, ra: { x: 0, y: 20 }, rb: { x: 0, y: 1020 } },
      sizes: sizes('a', 'b', 'ra', 'rb'),
      placed: { a: box(300, 200), b: box(300, 1200) },
      edges: [],
      dir: 'RIGHT',
      anchors: ['a', 'b'],
    });
    expect(out.ra.y).toBeLessThan(400);
    expect(out.rb.y).toBeGreaterThan(1000);
    expect(out.ra.x).toBeGreaterThan(400);
    expect(out.rb.x).toBeGreaterThan(400);
  });

  it('beside means below the card when the flow runs down', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, f: { x: 0, y: 0 } },
      sizes: sizes('a', 'f'),
      placed: { a: box(300, 200) },
      edges: [],
      dir: 'DOWN',
      anchors: ['a'],
    });
    expect(out.f.y).toBeGreaterThan(240);
    expect(out.f.x).toBe(300);
  });

  it('a placed card that grew keeps its place and pushes the cards it now covers, and those push the next ones', () => {
    const out = placeMerged({
      elk: {},
      sizes: { a: { width: 100, height: 200 }, b: size, c: size, d: size },
      placed: { a: box(0, 0), b: box(0, 60), c: box(0, 120), d: box(400, 0) },
      edges: [],
      dir: 'RIGHT',
    });
    expect(out.a).toBeUndefined();
    expect(out.b.y).toBeGreaterThanOrEqual(200);
    expect(out.c.y).toBeGreaterThanOrEqual(out.b.y + 40);
    expect(out.d).toBeUndefined(); // not in the way
  });

  it('a pinned (dragged) card is not pushed by a card that grew; the others still make room', () => {
    const out = placeMerged({
      elk: {},
      sizes: { a: { width: 100, height: 200 }, b: size, c: size },
      placed: { a: box(0, 0), b: box(0, 60), c: box(0, 120) },
      edges: [],
      dir: 'RIGHT',
      pinned: new Set(['b']),
    });
    expect(out.b).toBeUndefined();
    expect(out.c.y).toBeGreaterThanOrEqual(200);
  });

  it('with nothing placed it is ELK as it is', () => {
    const elk = { a: { x: 0, y: 0 }, b: { x: 200, y: 10 } };
    expect(placeMerged({ elk, sizes: sizes('a', 'b'), placed: {}, edges: [], dir: 'RIGHT' })).toEqual(elk);
  });
});
