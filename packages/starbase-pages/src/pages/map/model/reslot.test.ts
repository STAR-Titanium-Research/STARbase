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

  it('steps a card past one it would lie on when the slots are not the same size', () => {
    const boxes = { 'op:k': box(0, 0), a: box(300, 100, 100, 40), b: box(300, 0, 100, 300) };
    const two = wires(['op:k:out:0', 'a:in:0'], ['op:k:out:1', 'b:in:0']);
    const out = reslot({ container: container(rows.slice(0, 2)), wires: two, boxes, dragged: new Set(), dir: 'RIGHT' });
    expect(out.a).toEqual({ x: 300, y: 0 });
    expect(out.b!.y).toBeGreaterThanOrEqual(40 + 28); // clear of a
  });

  it('orders the input side by the input sockets, the bundle socket last', () => {
    const ins = [{ in: 'op:k:in:0' }, { in: 'op:k:in:b' }, { in: 'op:k:in:1' }];
    const inWires = wires(['a:out:0', 'op:k:in:0'], ['b:out:0', 'op:k:in:b'], ['c:out:0', 'op:k:in:1']);
    const boxes = { 'op:k': box(300, 0), a: box(0, 200), b: box(0, 0), c: box(0, 100) };
    // order: in:0 (a), in:1 (c), in:b (b)
    expect(reslot({ container: container(ins), wires: inWires, boxes, dragged: new Set(), dir: 'RIGHT' })).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 200 } });
  });
});
