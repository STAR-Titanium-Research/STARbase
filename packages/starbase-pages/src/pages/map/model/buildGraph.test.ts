import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkStock, mkTest } from './fixtures';
import { FALLBACK_RELATIONS, formSlots } from './formSlots';
import type { ContainerNode, MapNode, ProcessData, ProcessGraph, RecordNode } from './types';

const slots = () => [];

function build(data: ProcessData, o: { probable?: boolean; maxRows?: number } = {}): ProcessGraph {
  return buildGraph(data, groupsOf(data, o.probable ?? false), { slots, maxRows: o.maxRows });
}

const node = (g: ProcessGraph, id: string): MapNode | undefined => g.nodes.find((n) => n.id === id);
const container = (g: ProcessGraph, id: string) => node(g, id) as ContainerNode;
const record = (g: ProcessGraph, id: string) => node(g, id) as RecordNode;
const wire = (g: ProcessGraph, from: string, to: string) => g.wires.find((w) => w.from === from && w.to === to);

const sam = (...ids: string[]) => ids.map((id) => mkSample(id));

describe('buildGraph: operations and samples', () => {
  it('FAST op makes a sample', () => {
    const op = mkOp({ id: 'f1', sampleId: null, outputSampleId: 's1', methodName: 'FAST sintering' });
    const g = build(mkData({ samples: sam('s1'), operations: [op] }));

    const c = container(g, 'op:f1');
    expect(c.title).toBe('FAST sintering');
    expect(c.rows).toEqual([{ recordId: 'f1', sampleId: 's1', out: 'op:f1:out:0' }]);
    expect(c.rows[0].inPlace).toBeUndefined();
    const w = wire(g, 'op:f1:out:0', 's:s1:in:0');
    expect(w).toMatchObject({ carries: 's1', flow: 'sample', bundled: false, origin: 'op:f1' });
    expect(record(g, 's:s1').ins).toEqual(['s:s1:in:0']);
    expect(record(g, 's:s1').outs).toEqual(['s:s1:out:0']);
  });

  it('stock lot into the making op', () => {
    const op = mkOp({ id: 'f1', outputSampleId: 's1' });
    const g = build(mkData({ samples: sam('s1'), operations: [op], stock: [mkStock('l1', 's1')] }));

    expect(wire(g, 'lot:l1:out:0', 'op:f1:in:0')).toMatchObject({ flow: 'stock', carries: null, origin: 'lot:l1' });
    expect(container(g, 'op:f1').rows[0].in).toBe('op:f1:in:0');
    expect(g.wires.filter((w) => w.from === 'lot:l1:out:0')).toHaveLength(1);
    expect(record(g, 'lot:l1')).toMatchObject({ kind: 'stock_lot', ref: { code: 'L1' } });
  });

  it('stock lot into the card when no making op', () => {
    const g = build(mkData({ samples: sam('s1'), stock: [mkStock('l1', 's1')] }));
    expect(wire(g, 'lot:l1:out:0', 's:s1:in:0')).toMatchObject({ flow: 'stock', carries: null });
    expect(record(g, 's:s1').ins).toEqual(['s:s1:in:0']);
  });

  it('powder batch card', () => {
    const op = mkOp({ id: 'f1', outputSampleId: 's1', powderBatch: 'TIMET 45-150' });
    const g = build(mkData({ samples: sam('s1'), operations: [op] }));

    expect(record(g, 'pb:f1')).toMatchObject({ kind: 'powder_batch', ref: { code: 'TIMET 45-150' } });
    expect(wire(g, 'pb:f1:out:0', 'op:f1:in:0')).toMatchObject({ flow: 'stock', carries: null });
  });

  it('no powder batch card when the sample has a stock lot', () => {
    const op = mkOp({ id: 'f1', outputSampleId: 's1', powderBatch: 'TIMET 45-150' });
    const g = build(mkData({ samples: sam('s1'), operations: [op], stock: [mkStock('l1', 's1')] }));
    expect(node(g, 'pb:f1')).toBeUndefined();
    expect(wire(g, 'lot:l1:out:0', 'op:f1:in:0')).toBeDefined();
  });

  it('material only for a root without making op and lot', () => {
    const material = { collection: 'materials', id: 'mat1', code: 'Ti-6Al-4V' };
    const root = mkSample('s1', { materialRef: material });
    const made = mkSample('s2', { materialRef: material });
    const stocked = mkSample('s3', { materialRef: material });
    const data = mkData({
      samples: [root, made, stocked],
      operations: [mkOp({ id: 'f1', outputSampleId: 's2' })],
      stock: [mkStock('l1', 's3')],
    });
    const g = build(data);

    expect(record(g, 'm:s1')).toMatchObject({ kind: 'material', ref: material });
    expect(wire(g, 'm:s1:out:0', 's:s1:in:0')).toMatchObject({ flow: 'stock', carries: null });
    expect(node(g, 'm:s2')).toBeUndefined();
    expect(node(g, 'm:s3')).toBeUndefined();
  });

  it('no material card for a root whose material is unknown', () => {
    const g = build(mkData({ samples: sam('s1') }));
    expect(g.nodes.map((n) => n.id)).toEqual(['s:s1']);
  });

  it('zero-row container: an operation with neither sample', () => {
    const g = build(mkData({ samples: sam('s1'), operations: [mkOp({ id: 'x1' })] }));
    expect(container(g, 'op:x1').rows).toEqual([]);
    expect(g.wires).toEqual([]);
  });

  it('ignores references to samples that were not loaded', () => {
    const g = build(mkData({ samples: sam('s1'), operations: [mkOp({ id: 'x1', sampleId: 'gone', outputSampleId: 's1' })] }));
    expect(container(g, 'op:x1').rows[0]).toEqual({ recordId: 'x1', sampleId: 's1', out: 'op:x1:out:0' });
    expect(g.wires).toHaveLength(1);
  });
});

describe('buildGraph: in-place chains', () => {
  it('in-place chain: turning, polishing, a non-destructive test', () => {
    const data = mkData({
      samples: sam('s1'),
      operations: [
        // listed out of order on purpose
        mkOp({ id: 'pol', sampleId: 's1', date: '2026-09-12T09:00:00Z' }),
        mkOp({ id: 'turn', sampleId: 's1', date: '2026-09-10T09:00:00Z' }),
      ],
      tests: [mkTest({ id: 'nde', subjectSampleIds: ['s1'], category: 'nde', date: '2026-09-14T09:00:00Z' })],
    });
    const g = build(data);

    for (const [from, to] of [
      ['s:s1:out:0', 'op:turn:in:0'],
      ['op:turn:out:0', 'op:pol:in:0'],
      ['op:pol:out:0', 'test:nde:in:0'],
    ]) {
      expect(wire(g, from, to)).toMatchObject({ carries: 's1', flow: 'sample' });
    }
    expect(g.wires).toHaveLength(3);
    expect(g.nodes.filter((n) => n.type === 'record' && n.kind === 'sample')).toHaveLength(1);
    expect(wire(g, 'op:turn:out:0', 'op:pol:in:0')!.origin).toBe('op:turn');
    // in-place rows (no new sample) are marked for the pass-through line; a making row is not
    expect(container(g, 'op:turn').rows[0].inPlace).toBe(true);
    expect(container(g, 'test:nde').rows[0].inPlace).toBe(true);
    // the last step's output is left open
    expect(g.wires.some((w) => w.from === 'test:nde:out:0')).toBe(false);
    expect(container(g, 'test:nde').rows[0].out).toBe('test:nde:out:0');
  });

  it('same-day in-place order: no sequence, ordered by id, no cycle', () => {
    const date = '2026-09-10T09:00:00Z';
    const data = mkData({
      samples: sam('s1'),
      operations: [mkOp({ id: 'b', sampleId: 's1', date }), mkOp({ id: 'a', sampleId: 's1', date })],
    });
    const g = build(data);
    expect(g.wires).toHaveLength(2);
    expect(wire(g, 's:s1:out:0', 'op:a:in:0')).toBeDefined();
    expect(wire(g, 'op:a:out:0', 'op:b:in:0')).toBeDefined();
  });

  it('sequence breaks a same-day tie before the id does', () => {
    const date = '2026-09-10T09:00:00Z';
    const data = mkData({
      samples: sam('s1'),
      operations: [mkOp({ id: 'a', sampleId: 's1', date, sequence: 2 }), mkOp({ id: 'b', sampleId: 's1', date, sequence: 1 })],
    });
    const g = build(data);
    expect(wire(g, 's:s1:out:0', 'op:b:in:0')).toBeDefined();
    expect(wire(g, 'op:b:out:0', 'op:a:in:0')).toBeDefined();
  });

  it('a destructive test has no output and ends the chain', () => {
    const data = mkData({
      samples: sam('s1'),
      tests: [mkTest({ id: 'tt', subjectSampleIds: ['s1'], category: 'destructive', date: '2026-09-10T09:00:00Z' })],
    });
    const g = build(data);
    expect(container(g, 'test:tt').rows).toEqual([{ recordId: 'tt', sampleId: 's1', in: 'test:tt:in:0' }]);
    expect(wire(g, 's:s1:out:0', 'test:tt:in:0')).toBeDefined();
  });

  it('an operation that makes another sample leaves the first sample where it is', () => {
    const data = mkData({
      samples: sam('p', 'c'),
      operations: [
        mkOp({ id: 'pol', sampleId: 'p', date: '2026-09-10T09:00:00Z' }),
        mkOp({ id: 'cut', sampleId: 'p', outputSampleId: 'c', date: '2026-09-11T09:00:00Z' }),
        mkOp({ id: 'late', sampleId: 'p', date: '2026-09-12T09:00:00Z' }),
      ],
    });
    const g = build(data);
    // p → polish → cut (taken in after polish); the later in-place step continues from polish
    expect(wire(g, 'op:pol:out:0', 'op:cut:in:0')).toBeDefined();
    expect(wire(g, 'op:pol:out:0', 'op:late:in:0')).toBeDefined();
    expect(wire(g, 'op:cut:out:0', 's:c:in:0')).toBeDefined();
  });
});

describe('buildGraph: grouped cuts and bundling', () => {
  const DAY = '2026-03-04T09:00:00Z';
  const cut = (n: number) =>
    mkData({
      samples: sam('p', ...Array.from({ length: n }, (_, i) => `c${i}`)),
      operations: Array.from({ length: n }, (_, i) =>
        mkOp({ id: `cut${i}`, sampleId: 'p', outputSampleId: `c${i}`, date: DAY, methodName: 'Wire cut', equipmentId: 'eq1' }),
      ),
    });

  it('cut 1→N: one shared input, an output per row, folded past maxRows', () => {
    const data = cut(4);
    const g = build(data, { probable: true });
    const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;

    expect(c.probable).toBe(true);
    expect(c.title).toBe('Probable batch · Wire cut');
    expect(c.bundled).toBe(true);
    expect(c.rows.map((r) => r.in)).toEqual([`${c.id}:in:0`, `${c.id}:in:0`, `${c.id}:in:0`, `${c.id}:in:0`]);
    expect(c.rows.map((r) => r.out)).toEqual([`${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:b`, `${c.id}:out:b`]);
    expect(c.rows.map((r) => r.sampleId)).toEqual(['c0', 'c1', 'c2', 'c3']);

    expect(g.wires.filter((w) => w.to === `${c.id}:in:0`)).toHaveLength(1);
    expect(wire(g, 's:p:out:0', `${c.id}:in:0`)).toMatchObject({ carries: 'p', bundled: false });
    expect(wire(g, `${c.id}:out:0`, 's:c0:in:0')).toMatchObject({ bundled: false, carries: 'c0' });
    expect(wire(g, `${c.id}:out:1`, 's:c1:in:0')).toMatchObject({ bundled: false });
    expect(wire(g, `${c.id}:out:b`, 's:c2:in:0')).toMatchObject({ bundled: true, carries: 'c2' });
    expect(wire(g, `${c.id}:out:b`, 's:c3:in:0')).toMatchObject({ bundled: true, carries: 'c3' });
  });

  it('an unfolded container keeps every row on its own sockets', () => {
    const data = cut(4);
    const folded = build(data, { probable: true }).nodes.find((n): n is ContainerNode => n.type === 'container')!;
    const g = buildGraph(data, groupsOf(data, true), { slots, unfolded: new Set([folded.id]) });
    const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
    expect(c.bundled).toBe(false);
    expect(c.rows.map((r) => r.out)).toEqual([0, 1, 2, 3].map((i) => `${c.id}:out:${i}`));
    expect(g.wires.some((w) => w.bundled)).toBe(false);
  });

  it('three rows do not fold', () => {
    const g = build(cut(3), { probable: true });
    const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
    expect(c.bundled).toBe(false);
    expect(c.rows.map((r) => r.out)).toEqual([`${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:2`]);
    expect(g.wires.every((w) => !w.bundled)).toBe(true);
  });

  it('maxRows is configurable', () => {
    const g = build(cut(3), { probable: true, maxRows: 2 });
    const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
    expect(c.rows.map((r) => r.out)).toEqual([`${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:b`]);
  });

  it('a recorded batch of several input samples: one socket per sample, rows 2+ bundled', () => {
    const data = mkData({
      samples: sam('a', 'b', 'c', 'd'),
      operations: ['a', 'b', 'c', 'd'].map((s) => mkOp({ id: `h${s}`, sampleId: s, batchId: 'B1', methodName: 'Anneal' })),
    });
    const g = buildGraph(data, groupsOf(data), { slots, maxRows: 3 });
    const c = container(g, 'batch:B1');

    expect(c.title).toBe('Batch B1');
    expect(c.probable).toBe(false);
    expect(c.rows.map((r) => r.in)).toEqual(['batch:B1:in:0', 'batch:B1:in:1', 'batch:B1:in:b', 'batch:B1:in:b']);
    expect(wire(g, 's:c:out:0', 'batch:B1:in:b')).toMatchObject({ bundled: true });
    expect(wire(g, 's:d:out:0', 'batch:B1:in:b')).toMatchObject({ bundled: true });
    expect(wire(g, 's:a:out:0', 'batch:B1:in:0')).toMatchObject({ bundled: false });
  });

  it('keeps the first row slots for a multi-row group', () => {
    const data = cut(2);
    const g = buildGraph(data, groupsOf(data, true), {
      slots: (row) => [{ field: 'equipment_id', role: row.id, ref: null, major: true }],
    });
    const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
    expect(c.slots.map((s) => s.role)).toEqual(['cut0']);
    expect(c.settings).toEqual([]);
  });
});

describe('buildGraph: lineage', () => {
  it('lineage dedupe: covered rows draw no junction, uncovered ones do', () => {
    const data = mkData({
      samples: sam('s', 'a', 'b'),
      operations: [mkOp({ id: 'cutA', sampleId: 's', outputSampleId: 'a' })],
      lineage: [mkLineage('s', 'a', 'cut_from'), mkLineage('s', 'b', 'cut_from', 0.5)],
    });
    const g = build(data);

    expect(node(g, 'j:s:cut_from')).toMatchObject({
      type: 'junction',
      lineageType: 'cut_from',
      parentId: 's',
      in: 'j:s:cut_from:in:0',
      outs: [{ socket: 'j:s:cut_from:out:0', childId: 'b', fraction: 0.5 }],
    });
    expect(wire(g, 's:s:out:0', 'j:s:cut_from:in:0')).toMatchObject({ carries: 's', origin: 's:s' });
    expect(wire(g, 'j:s:cut_from:out:0', 's:b:in:0')).toMatchObject({ carries: 'b', origin: 'j:s:cut_from' });
    // the covered row is drawn through the operation only
    expect(g.nodes.filter((n) => n.type === 'junction')).toHaveLength(1);
    expect(wire(g, 'op:cutA:out:0', 's:a:in:0')).toBeDefined();
    expect(record(g, 's:a').ins).toEqual(['s:a:in:0']);
  });

  it('siblings with one parent and type share a junction; a different type gets its own', () => {
    const data = mkData({
      samples: sam('s', 'a', 'b', 'c'),
      lineage: [mkLineage('s', 'a'), mkLineage('s', 'b'), mkLineage('s', 'c', 'derived_from')],
    });
    const g = build(data);
    const cutJ = node(g, 'j:s:cut_from') as Extract<MapNode, { type: 'junction' }>;
    expect(cutJ.outs.map((o) => o.socket)).toEqual(['j:s:cut_from:out:0', 'j:s:cut_from:out:1']);
    expect(node(g, 'j:s:derived_from')).toBeDefined();
    expect(g.wires.filter((w) => w.to === 'j:s:cut_from:in:0')).toHaveLength(1);
  });

  it('multi-parent: a child with two uncovered parents has two input sockets', () => {
    const data = mkData({
      samples: sam('p1', 'p2', 'c'),
      lineage: [mkLineage('p1', 'c', 'derived_from'), mkLineage('p2', 'c', 'derived_from')],
    });
    const g = build(data);
    expect(record(g, 's:c').ins).toEqual(['s:c:in:0', 's:c:in:1']);
    expect(wire(g, 'j:p1:derived_from:out:0', 's:c:in:0')).toBeDefined();
    expect(wire(g, 'j:p2:derived_from:out:0', 's:c:in:1')).toBeDefined();
  });

  it('folds a sample card with more incoming wires than maxRows', () => {
    const parents = ['p1', 'p2', 'p3', 'p4'];
    const data = mkData({
      samples: sam(...parents, 'c'),
      lineage: parents.map((p) => mkLineage(p, 'c', 'derived_from')),
    });
    const g = build(data);
    expect(record(g, 's:c').ins).toEqual(['s:c:in:0', 's:c:in:1', 's:c:in:b']);
    expect(wire(g, 'j:p3:derived_from:out:0', 's:c:in:b')).toMatchObject({ bundled: true });
    expect(wire(g, 'j:p4:derived_from:out:0', 's:c:in:b')).toMatchObject({ bundled: true });
  });

  it('lineage-only family: sample cards and junctions, no operations or tests', () => {
    const data = mkData({
      samples: sam('s', 'a', 'b'),
      lineage: [mkLineage('s', 'a'), mkLineage('s', 'b', 'sintered_from')],
    });
    const g = build(data);
    expect(g.nodes.filter((n) => n.type === 'record')).toHaveLength(3);
    expect(g.nodes.filter((n) => n.type === 'junction')).toHaveLength(2);
    expect(g.wires.length).toBeGreaterThanOrEqual(1);
    expect(g.wires).toHaveLength(4);
  });
});

describe('buildGraph: hidden markers and flags', () => {
  const base = () => mkData({ samples: sam('s1'), operations: [mkOp({ id: 'f1', outputSampleId: 's1' })] });

  it('ancestors hidden → marker on the focus sample input side', () => {
    const g = build({ ...base(), hidden: { ancestors: true, descendants: false, events: false, stock: false } });
    expect(g.hidden).toEqual([{ nodeId: 's:s1', side: 'in' }]);
  });

  it('descendants hidden → marker on the output side', () => {
    const g = build({ ...base(), hidden: { ancestors: false, descendants: true, events: false, stock: false } });
    expect(g.hidden).toEqual([{ nodeId: 's:s1', side: 'out' }]);
  });

  it('stock and events fold into the same two markers', () => {
    const g = build({ ...base(), hidden: { ancestors: true, descendants: false, events: true, stock: true } });
    expect(g.hidden).toEqual([
      { nodeId: 's:s1', side: 'in' },
      { nodeId: 's:s1', side: 'out' },
    ]);
  });

  it('no markers when nothing is hidden; truncated is passed through', () => {
    const g = build({ ...base(), truncated: true });
    expect(g.hidden).toEqual([]);
    expect(g.truncated).toBe(true);
  });

  it('an operation focus hangs the markers on its container', () => {
    const data = {
      ...base(),
      focus: { collection: 'manufacturing_operations', id: 'f1', code: 'F1', kind: 'operation' as const },
      hidden: { ancestors: true, descendants: false, events: false, stock: false },
    };
    expect(build(data).hidden).toEqual([{ nodeId: 'op:f1', side: 'in' }]);
  });
});

describe('buildGraph: structure', () => {
  it('every wire connects declared sockets and ids are unique', () => {
    const data = mkData({
      samples: [mkSample('p', { materialRef: { collection: 'materials', id: 'm', code: 'Ti' } }), ...sam('a', 'b', 'c', 'd')],
      operations: [
        mkOp({ id: 'cut0', sampleId: 'p', outputSampleId: 'a', date: '2026-03-04T09:00:00Z' }),
        mkOp({ id: 'cut1', sampleId: 'p', outputSampleId: 'b', date: '2026-03-04T09:00:00Z' }),
        mkOp({ id: 'cut2', sampleId: 'p', outputSampleId: 'c', date: '2026-03-04T09:00:00Z' }),
        mkOp({ id: 'cut3', sampleId: 'p', outputSampleId: 'd', date: '2026-03-04T09:00:00Z' }),
        mkOp({ id: 'pol', sampleId: 'a', date: '2026-03-05T09:00:00Z' }),
      ],
      tests: [mkTest({ id: 'tt', subjectSampleIds: ['a', 'b'], category: 'nde', date: '2026-03-06T09:00:00Z' })],
    });
    const g = build(data, { probable: true });

    const sockets = new Set<string>();
    for (const n of g.nodes) {
      if (n.type === 'record') [...n.ins, ...n.outs].forEach((s) => sockets.add(s));
      else if (n.type === 'junction') {
        sockets.add(n.in);
        n.outs.forEach((o) => sockets.add(o.socket));
      } else
        for (const r of n.rows) {
          if (r.in) sockets.add(r.in);
          if (r.out) sockets.add(r.out);
        }
    }
    for (const w of g.wires) {
      expect(sockets.has(w.from), w.from).toBe(true);
      expect(sockets.has(w.to), w.to).toBe(true);
    }
    expect(new Set(g.wires.map((w) => w.id)).size).toBe(g.wires.length);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
  });

  it('a test on several subjects is one row with one input socket', () => {
    const data = mkData({
      samples: sam('a', 'b'),
      tests: [mkTest({ id: 'tt', subjectSampleIds: ['a', 'b'], category: 'nde' })],
    });
    const g = build(data);
    expect(container(g, 'test:tt').rows).toHaveLength(1);
    expect(wire(g, 's:a:out:0', 'test:tt:in:0')).toBeDefined();
    expect(wire(g, 's:b:out:0', 'test:tt:in:0')).toBeDefined();
  });
});

describe('buildGraph: Inside tray and settings of a container', () => {
  const ref = (collection: string, id: string) => ({ collection, id, code: id.toUpperCase() });

  it('a probable batch merges the slots and settings of its rows', () => {
    const mk = (id: string, tool: string, feed: number) =>
      mkOp({
        id,
        sampleId: 's1',
        outputSampleId: `s${id}`,
        methodId: 'mill',
        methodName: 'Milling',
        category: 'machining',
        equipmentId: 'e1',
        date: '2026-03-02T09:00:00Z',
        relations: { equipment_id: ref('equipment', 'e1'), tool_id: ref('tools', tool) },
        settings: { machining_cutting_speed_m_per_min: 120, machining_feed_mm_per_rev: feed },
      });
    const data = mkData({
      samples: sam('s1', 'sa', 'sb'),
      operations: [mk('a', 't1', 0.1), mk('b', 't2', 0.2)],
    });
    const g = buildGraph(data, groupsOf(data, true), {
      slots: (row, kind) => formSlots(row, kind, FALLBACK_RELATIONS[kind]),
    });
    const c = g.nodes.find((n) => n.type === 'container') as ContainerNode;

    expect(c.probable).toBe(true);
    expect(c.slots.filter((s) => s.role === 'Machine')).toHaveLength(1);
    expect(c.slots.find((s) => s.role === 'Machine')?.ref?.id).toBe('e1');
    const tools = c.slots.filter((s) => s.role === 'Tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].values).toHaveLength(2);
    expect(c.settings).toEqual([
      { label: 'Cutting speed', value: '120 m/min' },
      { label: 'Feed', value: 'varies' },
    ]);
  });

  it('rows that are not drawn feed neither the slots nor the settings', () => {
    const seen: string[] = [];
    const data = mkData({
      samples: sam('s1', 's2'),
      operations: [
        mkOp({ id: 'd', sampleId: 's1', outputSampleId: 's2', batchId: 'B1' }),
        mkOp({ id: 'x', sampleId: 'unknown', outputSampleId: null, batchId: 'B1' }),
      ],
    });
    buildGraph(data, groupsOf(data), {
      slots: (row) => {
        seen.push(row.id);
        return [];
      },
    });
    expect(seen).toEqual(['d']);
  });
});
