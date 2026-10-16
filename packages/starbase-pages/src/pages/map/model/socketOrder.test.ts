import { describe, expect, it } from 'vitest';
import { socketOrder } from './socketOrder';
import type { Point, Size } from './placeMerged';
import type { ContainerNode, JunctionNode, MapNode, RecordNode } from './types';

const rec = (id: string, ins: string[], outs: string[] = []): RecordNode =>
  ({ id, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: id }, ins, outs }) as RecordNode;
const container = (id: string, rows: { in?: string; out?: string }[]): ContainerNode => ({ id, type: 'container', kind: 'operation', rows, bundled: false }) as unknown as ContainerNode;
const junction = (id: string, outs: JunctionNode['outs']): JunctionNode => ({ id, type: 'junction', lineageType: 'cut_from', parentId: 'p', in: `${id}:in:0`, outs });
const w = (...pairs: [string, string][]) => pairs.map(([from, to]) => ({ from, to }));
const size: Size = { width: 100, height: 40 };
const sizesOf = (...ids: string[]): Record<string, Size> => Object.fromEntries(ids.map((id) => [id, size]));

describe('socketOrder (the cleanest order of the sockets on a card)', () => {
  // The screenshot: a Sample card's two in-sockets are wired from one card below-left and one card above; in the model's order the wires cross.
  const target = rec('s:t', ['s:t:in:0', 's:t:in:1']);
  const wires = w(['s:below:out:0', 's:t:in:0'], ['s:above:out:0', 's:t:in:1']);
  const sizes = sizesOf('s:t', 's:below', 's:above');

  it('sorts a side by the y of the other end when the flow runs right: the wire from above goes to the upper socket', () => {
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 100 }, 's:below': { x: 0, y: 300 }, 's:above': { x: 0, y: 0 } };
    const out = socketOrder(target, wires, positions, sizes, 'RIGHT') as RecordNode;
    expect(out.ins).toEqual(['s:t:in:1', 's:t:in:0']);
  });

  it('sorts by x when the flow runs down', () => {
    const positions: Record<string, Point> = { 's:t': { x: 100, y: 400 }, 's:below': { x: 300, y: 0 }, 's:above': { x: 0, y: 0 } };
    const out = socketOrder(target, wires, positions, sizes, 'DOWN') as RecordNode;
    expect(out.ins).toEqual(['s:t:in:1', 's:t:in:0']);
    // ...and y does not matter there: with the cards level in x the order is kept.
    const level: Record<string, Point> = { 's:t': { x: 0, y: 400 }, 's:below': { x: 0, y: 300 }, 's:above': { x: 0, y: 0 } };
    expect((socketOrder(target, wires, level, sizes, 'DOWN') as RecordNode).ins).toEqual(['s:t:in:0', 's:t:in:1']);
  });

  it('uses the centre of the other card (its top plus half its height)', () => {
    // A tall card at y 0 (centre 200) against a short one at y 150 (centre 170): the short one is higher.
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 's:below': { x: 0, y: 0 }, 's:above': { x: 0, y: 150 } };
    const s = { ...sizes, 's:below': { width: 100, height: 400 } };
    expect((socketOrder(target, wires, positions, s, 'RIGHT') as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0']);
  });

  it('sorts the outputs the same way', () => {
    const src = rec('s:src', [], ['s:src:out:0', 's:src:out:1']);
    const wo = w(['s:src:out:0', 's:low:in:0'], ['s:src:out:1', 's:high:in:0']);
    const positions: Record<string, Point> = { 's:src': { x: 0, y: 100 }, 's:low': { x: 300, y: 400 }, 's:high': { x: 300, y: 0 } };
    expect((socketOrder(src, wo, positions, sizesOf('s:src', 's:low', 's:high'), 'RIGHT') as RecordNode).outs).toEqual(['s:src:out:1', 's:src:out:0']);
  });

  it('keeps the model order for sockets whose other ends are level (ties are stable)', () => {
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 's:below': { x: 0, y: 50 }, 's:above': { x: 0, y: 50 } };
    const out = socketOrder(target, wires, positions, sizes, 'RIGHT');
    expect(out).toBe(target); // nothing to change: the same node comes back
  });

  it('keeps the bundle socket last, whatever the cards say', () => {
    const t = rec('s:t', ['s:t:in:b', 's:t:in:0', 's:t:in:1']);
    const wb = w(['s:a:out:0', 's:t:in:b'], ['s:below:out:0', 's:t:in:0'], ['s:above:out:0', 's:t:in:1']);
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 's:a': { x: 0, y: -500 }, 's:below': { x: 0, y: 300 }, 's:above': { x: 0, y: 0 } };
    expect((socketOrder(t, wb, positions, sizesOf('s:t', 's:a', 's:below', 's:above'), 'RIGHT') as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0', 's:t:in:b']);
  });

  it('averages the other ends of a socket with several wires', () => {
    const t = rec('s:t', ['s:t:in:0', 's:t:in:1']);
    // in:0 has wires from y 0 and y 400 (average 200); in:1 from y 100: so in:1 is first.
    const wm = w(['s:a:out:0', 's:t:in:0'], ['s:b:out:0', 's:t:in:0'], ['s:c:out:0', 's:t:in:1']);
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 's:a': { x: 0, y: 0 }, 's:b': { x: 0, y: 400 }, 's:c': { x: 0, y: 100 } };
    expect((socketOrder(t, wm, positions, sizesOf('s:t', 's:a', 's:b', 's:c'), 'RIGHT') as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0']);
  });

  it('leaves a socket with no drawn wire in its slot and sorts the others around it', () => {
    const t = rec('s:t', ['s:t:in:0', 's:t:in:1', 's:t:in:2']);
    const wm = w(['s:below:out:0', 's:t:in:0'], ['s:above:out:0', 's:t:in:2']);
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 's:below': { x: 0, y: 300 }, 's:above': { x: 0, y: 0 } };
    expect((socketOrder(t, wm, positions, sizesOf('s:t', 's:below', 's:above'), 'RIGHT') as RecordNode).ins).toEqual(['s:t:in:2', 's:t:in:1', 's:t:in:0']);
  });

  it("uses the place of the socket on a container row when that is the other end, not the container's centre", () => {
    const c = container('op:k', [{ out: 'op:k:out:0' }, { out: 'op:k:out:1' }, { out: 'op:k:out:2' }]);
    const t = rec('s:t', ['s:t:in:0', 's:t:in:1']);
    // Both wires come from the same container (one centre): its sockets are spread down its height, so out:2 is lower than out:0.
    const wc = w(['op:k:out:2', 's:t:in:0'], ['op:k:out:0', 's:t:in:1']);
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 'op:k': { x: 0, y: 0 } };
    const sizes = { 's:t': size, 'op:k': { width: 264, height: 300 } };
    const byId = new Map<string, MapNode>([['op:k', c]]);
    expect((socketOrder(t, wc, positions, sizes, 'RIGHT', byId) as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0']);
    // DOWN: spread along its width.
    const down = { 's:t': { x: 0, y: 400 }, 'op:k': { x: 0, y: 0 } };
    expect((socketOrder(t, wc, down, { 's:t': size, 'op:k': { width: 300, height: 100 } }, 'DOWN', byId) as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0']);
  });

  it("puts a socket on a container's bundle (rows 3 and on share one socket, drawn last) after its row sockets", () => {
    const c = container('op:k', [{ out: 'op:k:out:0' }, { out: 'op:k:out:b' }]);
    const t = rec('s:t', ['s:t:in:0', 's:t:in:1']);
    const wc = w(['op:k:out:b', 's:t:in:0'], ['op:k:out:0', 's:t:in:1']);
    const positions: Record<string, Point> = { 's:t': { x: 400, y: 0 }, 'op:k': { x: 0, y: 0 } };
    const sizes = { 's:t': size, 'op:k': { width: 264, height: 300 } };
    expect((socketOrder(t, wc, positions, sizes, 'RIGHT', new Map<string, MapNode>([['op:k', c]])) as RecordNode).ins).toEqual(['s:t:in:1', 's:t:in:0']);
  });

  it('orders the outputs of a junction with their fractions', () => {
    const j = junction('j:1', [
      { socket: 'j:1:out:0', childId: 'low', fraction: 0.25 },
      { socket: 'j:1:out:1', childId: 'high', fraction: 0.75 },
    ]);
    const wj = w(['j:1:out:0', 's:low:in:0'], ['j:1:out:1', 's:high:in:0']);
    const positions: Record<string, Point> = { 'j:1': { x: 0, y: 100 }, 's:low': { x: 300, y: 400 }, 's:high': { x: 300, y: 0 } };
    const out = socketOrder(j, wj, positions, sizesOf('j:1', 's:low', 's:high'), 'RIGHT') as JunctionNode;
    expect(out.outs).toEqual([
      { socket: 'j:1:out:1', childId: 'high', fraction: 0.75 },
      { socket: 'j:1:out:0', childId: 'low', fraction: 0.25 },
    ]);
    expect(out.in).toBe(j.in);
  });

  it("does not touch a container (its rows are the sockets' order), and never mutates the node it is given", () => {
    const c = container('op:k', [
      { in: 'op:k:in:0', out: 'op:k:out:0' },
      { in: 'op:k:in:1', out: 'op:k:out:1' },
    ]);
    const positions: Record<string, Point> = { 'op:k': { x: 400, y: 0 }, 's:a': { x: 0, y: 300 }, 's:b': { x: 0, y: 0 } };
    expect(socketOrder(c, w(['s:a:out:0', 'op:k:in:0'], ['s:b:out:0', 'op:k:in:1']), positions, sizesOf('op:k', 's:a', 's:b'), 'RIGHT')).toBe(c);
    const before = JSON.stringify(target);
    socketOrder(target, wires, { 's:t': { x: 400, y: 100 }, 's:below': { x: 0, y: 300 }, 's:above': { x: 0, y: 0 } }, sizes, 'RIGHT');
    expect(JSON.stringify(target)).toBe(before);
  });

  it('copes with a wire to a card that has no place yet (it counts for nothing)', () => {
    expect(socketOrder(target, wires, { 's:t': { x: 0, y: 0 } }, sizes, 'RIGHT')).toBe(target);
  });
});
