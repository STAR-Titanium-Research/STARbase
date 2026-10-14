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

  it('a card pushed by a card that grew is not put on a pinned card on its way: it goes on past it', () => {
    const tall = { width: 100, height: 200 };
    const out = placeMerged({
      elk: {},
      sizes: { a: tall, b: tall, c: size },
      placed: { a: box(0, 0), b: { x: 0, y: 60, ...tall }, c: box(0, 120) }, // a grew 40 -> 200; b was dragged under it
      edges: [],
      dir: 'RIGHT',
      pinned: new Set(['b']),
    });
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
    expect(out.c.y).toBeGreaterThanOrEqual(60 + 200 + 28);
  });

  it('dragged cards do not count when new cards are lined up with the placed ones', () => {
    const out = placeMerged({
      elk: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, n: { x: 0, y: 200 } },
      sizes: sizes('a', 'b', 'n'),
      placed: { a: box(0, 0), b: box(900, 900) }, // b was dragged far away
      edges: [],
      dir: 'RIGHT',
      pinned: new Set(['b']),
    });
    expect(out.n).toEqual({ x: 0, y: 200 });
  });

  it('a card that hops past a dragged card clears the placed cards it lands on', () => {
    // G grew 40 -> 200. X (0,100) is pushed to 228, which is on the dragged P (0,240, 50 wide): it hops to 308 and now lies on N (90,280).
    const out = placeMerged({
      elk: {},
      sizes: { g: { width: 100, height: 200 }, x: size, p: { width: 50, height: 40 }, n: size },
      placed: { g: box(0, 0), x: box(0, 100), p: { x: 0, y: 240, width: 50, height: 40 }, n: box(90, 280) },
      edges: [],
      dir: 'RIGHT',
      pinned: new Set(['p']),
    });
    expect(out.p).toBeUndefined();
    expect(out.x.y).toBeGreaterThanOrEqual(240 + 40 + 28);
    expect(out.n.y).toBeGreaterThanOrEqual(out.x.y + 40); // N is pushed on, past X
  });

  it('with nothing placed it is ELK as it is', () => {
    const elk = { a: { x: 0, y: 0 }, b: { x: 200, y: 10 } };
    expect(placeMerged({ elk, sizes: sizes('a', 'b'), placed: {}, edges: [], dir: 'RIGHT' })).toEqual(elk);
  });
});

// Small random layouts: whatever grows and whatever is dragged, no dragged card moves and no two cards end up on each other.
describe('placeMerged (random layouts)', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  type R = { x: number; y: number; width: number; height: number };
  const hits = (a: R, b: R) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  // dir RIGHT: cards stack along y. DOWN is the same layout with x and y (and width and height) swapped.
  const flip = (b: R): R => ({ x: b.y, y: b.x, width: b.height, height: b.width });

  for (const dir of ['RIGHT', 'DOWN'] as const) {
    it(`never moves a dragged card and never leaves two cards on each other (${dir}, 200 layouts)`, () => {
      const rand = rng(20261014);
      const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
      let checked = 0;
      for (let round = 0; round < 200; round++) {
        const was: Record<string, R> = {};
        const n = int(3, 8);
        for (let tries = 0; Object.keys(was).length < n && tries < 60; tries++) {
          const b = { x: int(0, 20) * 10, y: int(0, 60) * 10, width: int(2, 3) * 50 - (rand() < 0.3 ? 50 : 0), height: 40 };
          if (!Object.values(was).some((o) => hits(b, o))) was[`c${Object.keys(was).length}`] = b;
        }
        const ids = Object.keys(was);
        const pinned = new Set(ids.filter(() => rand() < 0.35));
        const now: Record<string, R> = {};
        for (const id of ids) now[id] = !pinned.has(id) && rand() < 0.35 ? { ...was[id], height: int(80, 250) } : { ...was[id] };
        // A card that grew onto a dragged card cannot be helped (the dragged card does not move): not a case.
        if (ids.some((a) => pinned.has(a) && ids.some((b) => b !== a && hits(was[a], now[b])))) continue;
        const fresh: Record<string, R> = {};
        for (let i = 0; i < int(0, 3); i++) fresh[`f${i}`] = { x: int(0, 20) * 10, y: int(0, 60) * 10, width: 100, height: 40 };

        const t = dir === 'RIGHT' ? (b: R) => b : flip;
        const elk = Object.fromEntries(Object.entries(fresh).map(([id, b]) => [id, { x: t(b).x, y: t(b).y }]));
        const sizes = Object.fromEntries([...Object.entries(now), ...Object.entries(fresh)].map(([id, b]) => [id, { width: t(b).width, height: t(b).height }]));
        const placedIn = Object.fromEntries(ids.map((id) => [id, t(was[id])]));
        const out = placeMerged({ elk, sizes, placed: placedIn, edges: [], dir, pinned });

        const final = new Map<string, R>();
        for (const id of [...ids, ...Object.keys(fresh)]) {
          const at = out[id] ?? (id in placedIn ? placedIn[id] : undefined);
          final.set(id, { x: at!.x, y: at!.y, width: sizes[id].width, height: sizes[id].height });
        }
        for (const id of pinned) expect(out[id], `round ${round}: dragged ${id} moved`).toBeUndefined();
        const all = [...final];
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) expect(hits(all[i][1], all[j][1]), `round ${round}: ${all[i][0]} and ${all[j][0]} overlap`).toBe(false);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    });
  }
});
