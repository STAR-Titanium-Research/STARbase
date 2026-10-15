import { describe, expect, it } from 'vitest';
import { reslot } from './reslot';
import type { Box } from './placeMerged';
import type { ContainerNode } from './types';

const box = (x: number, y: number, width = 100, height = 40): Box => ({ x, y, width, height });
const container = (rows: { in?: string; out?: string }[]): ContainerNode =>
  ({ id: 'op:k', type: 'container', kind: 'operation', rows, bundled: false }) as unknown as ContainerNode;
const wires = (...pairs: [string, string][]) => pairs.map(([from, to]) => ({ from, to }));

describe('reslot', () => {
  const rows = [{ out: 'op:k:out:0' }, { out: 'op:k:out:1' }, { out: 'op:k:out:2' }];
  const w = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'b:in:0'], ['op:k:out:2', 'c:in:0']);

  it('deals the cross-axis places the neighbours have in the order of the sockets, keeping the flow-axis place', () => {
    const boxes = { 'op:k': box(0, 0, 100, 200), a: box(300, 200), b: box(310, 0), c: box(320, 100) };
    expect(reslot({ container: container(rows), wires: w, boxes, dragged: new Set(), dir: 'RIGHT' })).toEqual({ a: { x: 300, y: 0 }, b: { x: 310, y: 100 }, c: { x: 320, y: 200 } });
    const down = { 'op:k': box(0, 0, 400, 50), a: box(400, 300), b: box(0, 310), c: box(200, 320) };
    expect(reslot({ container: container(rows), wires: w, boxes: down, dragged: new Set(), dir: 'DOWN' })).toEqual({ a: { x: 0, y: 300 }, b: { x: 200, y: 310 }, c: { x: 400, y: 320 } });
  });

  it('leaves a dragged neighbour and its slot out of the dealing', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 200), b: box(300, 900), c: box(300, 0) };
    expect(reslot({ container: container(rows), wires: w, boxes, dragged: new Set(['b']), dir: 'RIGHT' })).toEqual({ a: { x: 300, y: 0 }, c: { x: 300, y: 200 } });
  });

  it('does not move a card that is already in place, nor one that is not on a socket', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 0), b: box(300, 100), c: box(300, 200), z: box(300, 400) };
    expect(reslot({ container: container(rows), wires: w, boxes, dragged: new Set(), dir: 'RIGHT' })).toEqual({});
  });

  /** No two of the cards lie on each other (with the gap kept). */
  const apart = (boxes: Record<string, Box>, out: Record<string, { x: number; y: number }>, ids: string[]) => {
    const at = (id: string) => ({ ...boxes[id], ...(out[id] ?? {}) });
    for (const i of ids) for (const j of ids) if (i < j) expect(at(i).y + at(i).height + 28 <= at(j).y || at(j).y + at(j).height + 28 <= at(i).y, `${i} and ${j} apart`).toBe(true);
  };

  it('puts cards of different sizes one after the other in socket order: a tall card in the first slot pushes the next ones along', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 100, 100, 300), b: box(300, 0, 100, 40) };
    const two = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'b:in:0']);
    const out = reslot({ container: container(rows.slice(0, 2)), wires: two, boxes, dragged: new Set(), dir: 'RIGHT' });
    expect(out.a).toEqual({ x: 300, y: 0 });
    expect(out.b).toEqual({ x: 300, y: 328 }); // just clear of a, not in its own slot (100), which a covers
  });

  it('keeps the order A, B, C and clears every overlap when the first card is much taller than the slots after it', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 1000, 100, 400), b: box(300, 300), c: box(300, 0) };
    const out = reslot({ container: container(rows), wires: w, boxes, dragged: new Set(), dir: 'RIGHT' });
    const y = (id: keyof typeof boxes) => (out[id] ?? boxes[id]).y;
    expect(y('a')).toBeLessThan(y('b'));
    expect(y('b')).toBeLessThan(y('c'));
    apart(boxes, out, ['a', 'b', 'c']);
  });

  it('steps a card past one that is not dealt and lies on its slot', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 200), b: box(300, 100), z: box(300, 90) }; // z is on nothing and lies on a's new slot (100)
    const two = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'b:in:0']);
    const out = reslot({ container: container(rows.slice(0, 2)), wires: two, boxes, dragged: new Set(), dir: 'RIGHT' });
    expect(out.a).toEqual({ x: 300, y: 158 }); // past z (90 to 130, plus the gap), not onto it
    expect(out.b!.y).toBeGreaterThanOrEqual(158 + 40 + 28);
    expect(out.z).toBeUndefined();
  });

  it('does not deal again a card that is also on another container socket: it would break the order there', () => {
    // k puts A on out:0 and X on out:1; m takes X on in:0 and B on in:1. X (y 0) is above B (y 100): m's order. Dealing X to k's second slot would put it below B.
    const k = container([{ out: 'op:k:out:0' }, { out: 'op:k:out:1' }]);
    const m = { ...container([{ in: 'op:m:in:0' }, { in: 'op:m:in:1' }]), id: 'op:m' } as ContainerNode;
    const both = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'x:in:0'], ['x:out:0', 'op:m:in:0'], ['b:out:0', 'op:m:in:1']);
    const boxes = { 'op:k': box(0, 0), 'op:m': box(600, 0), a: box(300, 200), x: box(300, 0), b: box(300, 100) };
    const out = reslot({ container: k, wires: both, boxes, dragged: new Set(), dir: 'RIGHT', containers: [k, m] });
    expect(out.x).toBeUndefined();
    expect((out.x ?? boxes.x).y).toBeLessThan((out.b ?? boxes.b).y); // m's order is kept
    // without the other container known it would be dealt (the guard is what keeps it)
    expect(reslot({ container: k, wires: both, boxes, dragged: new Set(), dir: 'RIGHT' }).x).toBeDefined();
  });

  it('a card that is on another container with one socket per side is still dealt (its order cannot break)', () => {
    const k = container([{ out: 'op:k:out:0' }, { out: 'op:k:out:1' }]);
    const m = { ...container([{ in: 'op:m:in:0' }]), id: 'op:m' } as ContainerNode;
    const both = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'x:in:0'], ['x:out:0', 'op:m:in:0']);
    const boxes = { 'op:k': box(0, 0), 'op:m': box(600, 0), a: box(300, 200), x: box(300, 0) };
    expect(reslot({ container: k, wires: both, boxes, dragged: new Set(), dir: 'RIGHT', containers: [k, m] }).x).toEqual({ x: 300, y: 200 });
  });

  it('orders the input side by the input sockets, the bundle socket last', () => {
    const ins = [{ in: 'op:k:in:0' }, { in: 'op:k:in:b' }, { in: 'op:k:in:1' }];
    const inWires = wires(['a:out:0', 'op:k:in:0'], ['b:out:0', 'op:k:in:b'], ['c:out:0', 'op:k:in:1']);
    const boxes = { 'op:k': box(300, 0), a: box(0, 200), b: box(0, 0), c: box(0, 100) };
    // order: in:0 (a), in:1 (c), in:b (b)
    expect(reslot({ container: container(ins), wires: inWires, boxes, dragged: new Set(), dir: 'RIGHT' })).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 200 } });
  });
});
