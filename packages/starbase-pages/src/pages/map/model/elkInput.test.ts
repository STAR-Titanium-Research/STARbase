import { describe, expect, it } from 'vitest';
import { elkInput } from './elkInput';
import type { ContainerNode, JunctionNode, ProcessGraph, RecordNode, Wire } from './types';

const ref = (id: string) => ({ collection: 'physical_samples', id, code: id.toUpperCase() });

const card = (id: string, ins: string[], outs: string[]): RecordNode => ({
  id,
  type: 'record',
  kind: 'sample',
  ref: ref(id),
  ins,
  outs,
});

const container = (id: string, rows: { in?: string; out?: string }[]): ContainerNode => ({
  id,
  type: 'container',
  kind: 'operation',
  group: { id, kind: 'operation', rowIds: rows.map((_, i) => `r${i}`), batch: null },
  title: 'Cut',
  code: id.toUpperCase(),
  category: 'machining',
  rows: rows.map((r, i) => ({ recordId: `r${i}`, ...r })),
  slots: [],
  settings: [],
  bundled: false,
  probable: false,
});

const wire = (from: string, to: string): Wire => ({
  id: `${from}>${to}`,
  from,
  to,
  carries: null,
  flow: 'sample',
  bundled: false,
  origin: 'x',
});

/** a (1 out) -> op (3 rows) -> b (1 in), and a -> junction -> c. */
function graph(): ProcessGraph {
  const op = container('op:cut', [
    { in: 'op:cut:in:0', out: 'op:cut:out:0' },
    { in: 'op:cut:in:1', out: 'op:cut:out:1' },
    { in: 'op:cut:in:b', out: 'op:cut:out:b' },
  ]);
  const junction: JunctionNode = {
    id: 'j:a',
    type: 'junction',
    lineageType: 'cut_from',
    parentId: 'a',
    in: 'j:a:in:0',
    outs: [{ socket: 'j:a:out:0', childId: 'c', fraction: null }],
  };
  return {
    nodes: [
      card('s:a', [], ['s:a:out:0']),
      op,
      card('s:b', ['s:b:in:0'], ['s:b:out:0']),
      junction,
      card('s:c', ['s:c:in:0'], ['s:c:out:0']),
    ],
    wires: [
      wire('s:a:out:0', 'op:cut:in:0'),
      wire('op:cut:out:0', 's:b:in:0'),
      wire('s:a:out:0', 'j:a:in:0'),
      wire('j:a:out:0', 's:c:in:0'),
    ],
    hidden: [],
    truncated: false,
  };
}

const all = (g: ProcessGraph) => new Set(g.nodes.map((n) => n.id));
const sizes = {
  's:a': { width: 100, height: 40 },
  'op:cut': { width: 240, height: 180 },
  's:b': { width: 100, height: 40 },
  'j:a': { width: 20, height: 20 },
  's:c': { width: 100, height: 40 },
};
const child = (root: ReturnType<typeof elkInput>, id: string) => root.children!.find((c) => c.id === id)!;

describe('elkInput', () => {
  it('sets the layered root options', () => {
    const root = elkInput(graph(), all(graph()), sizes, 'RIGHT');
    expect(root.layoutOptions).toEqual({
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '36',
      'elk.edgeRouting': 'SPLINES',
    });
  });

  it('ports follow row order, bundle last, on a fixed-order container', () => {
    const op = child(elkInput(graph(), all(graph()), sizes, 'RIGHT'), 'op:cut');
    expect(op.layoutOptions?.['elk.portConstraints']).toBe('FIXED_ORDER');
    const ports = op.ports!.map((p) => p.id);
    expect(ports).toEqual(['op:cut:in:0', 'op:cut:in:1', 'op:cut:in:b', 'op:cut:out:0', 'op:cut:out:1', 'op:cut:out:b']);
    const sides = op.ports!.map((p) => p.layoutOptions?.['elk.port.side']);
    expect(sides).toEqual(['WEST', 'WEST', 'WEST', 'EAST', 'EAST', 'EAST']);
  });

  it('lists one port for a socket shared by several rows', () => {
    const op = container('op:g', [
      { in: 'op:g:in:0', out: 'op:g:out:0' },
      { in: 'op:g:in:0', out: 'op:g:out:1' },
    ]);
    const g: ProcessGraph = { nodes: [op], wires: [], hidden: [], truncated: false };
    const ports = child(elkInput(g, all(g), { 'op:g': { width: 1, height: 1 } }, 'RIGHT'), 'op:g').ports!;
    expect(ports.map((p) => p.id)).toEqual(['op:g:in:0', 'op:g:out:0', 'op:g:out:1']);
  });

  it('sizes are passed through, ports get a small fixed size, edges join port ids', () => {
    const root = elkInput(graph(), all(graph()), sizes, 'RIGHT');
    expect(child(root, 'op:cut')).toMatchObject({ width: 240, height: 180 });
    expect(child(root, 's:a')).toMatchObject({ width: 100, height: 40 });
    expect(child(root, 's:a').ports).toEqual([
      expect.objectContaining({ id: 's:a:out:0', width: 12, height: 12 }),
    ]);
    expect(root.edges!.map((e) => [e.sources[0], e.targets[0]])).toEqual([
      ['s:a:out:0', 'op:cut:in:0'],
      ['op:cut:out:0', 's:b:in:0'],
      ['s:a:out:0', 'j:a:in:0'],
      ['j:a:out:0', 's:c:in:0'],
    ]);
  });

  it('falls back to a default size when a node has no measure yet', () => {
    const root = elkInput(graph(), all(graph()), {}, 'RIGHT');
    const a = child(root, 's:a');
    expect(a.width).toBeGreaterThan(0);
    expect(a.height).toBeGreaterThan(0);
  });

  it('hidden nodes and their wires are left out', () => {
    const g = graph();
    const shown = new Set(['s:a', 'op:cut']);
    const root = elkInput(g, shown, sizes, 'RIGHT');
    expect(root.children!.map((c) => c.id)).toEqual(['s:a', 'op:cut']);
    expect(root.edges!.map((e) => e.id)).toEqual(['s:a:out:0>op:cut:in:0']);
  });

  it('skips a wire to a socket that is not on its node', () => {
    const g = graph();
    g.wires.push(wire('s:a:out:0', 'op:cut:in:9'));
    const root = elkInput(g, all(g), sizes, 'RIGHT');
    expect(root.edges!.some((e) => e.targets[0] === 'op:cut:in:9')).toBe(false);
  });

  it('DOWN uses NORTH/SOUTH ports', () => {
    const root = elkInput(graph(), all(graph()), sizes, 'DOWN');
    expect(root.layoutOptions?.['elk.direction']).toBe('DOWN');
    const op = child(root, 'op:cut');
    expect(op.ports!.map((p) => p.layoutOptions?.['elk.port.side'])).toEqual(['NORTH', 'NORTH', 'NORTH', 'SOUTH', 'SOUTH', 'SOUTH']);
    expect(child(root, 'j:a').ports!.map((p) => p.layoutOptions?.['elk.port.side'])).toEqual(['NORTH', 'SOUTH']);
  });
});
