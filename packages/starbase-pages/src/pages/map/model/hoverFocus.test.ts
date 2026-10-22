import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { groupsOf, mkData, mkOp, mkSample } from './fixtures';
import { chainFocus, hoverFocus, socketSubjects, wiresAtSocket } from './hoverFocus';
import type { Slot } from './types';

describe('chainFocus', () => {
  // m --Cut (one batch)--> c0, c1, c2;  c0 --Polish--> d;  c1 --Polish--> e
  const day = '2026-09-01T09:00:00Z';
  const cut = mkData({
    samples: ['m', 'c0', 'c1', 'c2', 'd', 'e'].map((id) => mkSample(id)),
    operations: [
      ...['c0', 'c1', 'c2'].map((c) => mkOp({ id: `cut-${c}`, methodName: 'Cut', sampleId: 'm', outputSampleId: c, date: day, equipmentId: 'eq' })),
      mkOp({ id: 'pol-d', methodName: 'Polish', sampleId: 'c0', outputSampleId: 'd', date: '2026-09-03T09:00:00Z' }),
      mkOp({ id: 'pol-e', methodName: 'Polish', sampleId: 'c1', outputSampleId: 'e', date: '2026-09-04T09:00:00Z' }),
    ],
  });
  const g = buildGraph(cut, groupsOf(cut, true), { slots: () => [] });
  const opOf = (row: string) => g.nodes.find((n) => n.type === 'container' && n.group.rowIds.includes(row))!.id;

  const sorted = (s: Set<string>) => [...s].sort();
  const behind = ['s:m', opOf('cut-c0'), 's:c0'];
  const ahead = ['s:c0', opOf('pol-d'), 's:d'];

  it('both (the default): back through its own row of the cut, on to what came after; siblings stay dim', () => {
    const f = chainFocus(g, 's:c0')!;
    expect(f.dim).toBe(true);
    expect(f.soft).toBe(true); // a chain dims lightly: "not on this chain", not "disabled"
    expect(sorted(f.nodes)).toEqual([...new Set([...behind, ...ahead])].sort());
    expect(f.nodes.has('s:c1')).toBe(false);
    expect(f.nodes.has('s:e')).toBe(false);
  });

  it('upstream only: what it came from', () => {
    expect(sorted(chainFocus(g, 's:c0', 'up')!.nodes)).toEqual([...behind].sort());
  });

  it('downstream only: what it went on to', () => {
    expect(sorted(chainFocus(g, 's:c0', 'down')!.nodes)).toEqual([...ahead].sort());
  });

  it('the root downstream: every piece and branch', () => {
    const f = chainFocus(g, 's:m', 'down')!;
    for (const id of ['s:c0', 's:c1', 's:c2', 's:d', 's:e']) expect(f.nodes.has(id)).toBe(true);
    expect(f.wires.size).toBe(g.wires.length);
    expect(sorted(chainFocus(g, 's:m', 'up')!.nodes)).toEqual(['s:m']);
  });

  it('nothing selected, or an id not on the map: no chain', () => {
    expect(chainFocus(g, null)).toBeNull();
    expect(chainFocus(g, 'nope')).toBeNull();
  });
});

const DAY = '2026-09-01T09:00:00Z';
const slot: Slot = { field: 'equipment_id', role: 'Machine', ref: { collection: 'equipment', id: 'e1', code: 'Mill' }, major: true };
// p --Cut--> a --Sinter--> b, and c alone
const data = mkData({
  samples: [mkSample('p'), mkSample('a'), mkSample('b'), mkSample('c')],
  operations: [
    mkOp({ id: 'o1', methodName: 'Cut', sampleId: 'p', outputSampleId: 'a', date: DAY }),
    mkOp({ id: 'o2', methodName: 'Sinter', sampleId: 'a', outputSampleId: 'b', date: '2026-09-02T09:00:00Z' }),
  ],
});
const graph = buildGraph(data, groupsOf(data), { slots: (row) => (row.id === 'o1' ? [slot] : []) });
const op = (id: string) => graph.nodes.find((n) => n.type === 'container' && n.group.rowIds[0] === id)!.id;

describe('hoverFocus', () => {
  it('a card: its own wires and neighbours stay, the rest dims', () => {
    const f = hoverFocus(graph, 's:a')!;
    expect(f.dim).toBe(true);
    expect([...f.nodes].sort()).toEqual([op('o1'), op('o2'), 's:a'].sort());
    for (const w of graph.wires) expect(f.wires.has(w.id)).toBe(w.from.startsWith('s:a:') || w.to.startsWith('s:a:'));
    expect(f.nodes.has('s:c')).toBe(false);
  });

  it('a slot record: the cards that hold it with their neighbours and wires', () => {
    const f = hoverFocus(graph, 'equipment:e1')!;
    expect(f.dim).toBe(true);
    expect(f.soft).toBeUndefined(); // hovering a record in a tray dims strongly
    expect(f.nodes.has(op('o1'))).toBe(true);
    expect(f.nodes.has('s:p')).toBe(true);
    expect(f.nodes.has(op('o2'))).toBe(false);
  });

  it('a wire: highlights itself, dims nothing', () => {
    const w = graph.wires[0];
    expect(hoverFocus(graph, w.id)).toEqual({ dim: false, nodes: new Set(), wires: new Set([w.id]) });
  });

  it('a socket: highlights the wires on it, dims nothing', () => {
    const f = hoverFocus(graph, 's:a:out:0')!;
    expect(f.dim).toBe(false);
    expect([...f.wires]).toEqual(wiresAtSocket(graph, 's:a:out:0').map((w) => w.id));
    expect(f.wires.size).toBe(1);
  });

  it('nothing hovered or an unknown id: no focus', () => {
    expect(hoverFocus(graph, null)).toBeNull();
    expect(hoverFocus(graph, 'nope')).toBeNull();
  });
});

describe('wiresAtSocket', () => {
  it('lists the wires that leave or enter a socket', () => {
    const ws = wiresAtSocket(graph, 's:a:in:0');
    expect(ws).toHaveLength(1);
    expect(ws[0].to).toBe('s:a:in:0');
    expect(wiresAtSocket(graph, 's:c:in:0')).toEqual([]);
  });
});

describe('socketSubjects', () => {
  it('names the nodes the wires on a socket touch, and the sample they carry', () => {
    const subjects = socketSubjects(graph, 's:a:out:0');
    expect(subjects.has('s:a')).toBe(true);
    expect(subjects.has(op('o2'))).toBe(true);
    expect(subjects.has(op('o1'))).toBe(false);
    expect(socketSubjects(graph, 'nope').size).toBe(0);
  });
});
