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
      batchCodes: { B1: 'B-0003' },
    });
    const g = buildGraph(data, groupsOf(data), { slots, maxRows: 3 });
    const c = container(g, 'batch:B1');

    expect(c.title).toBe('Batch B-0003');
    expect(c.code).toBe('B-0003');
    expect(c.probable).toBe(false);
    expect(c.rows.map((r) => r.in)).toEqual(['batch:B1:in:0', 'batch:B1:in:1', 'batch:B1:in:b', 'batch:B1:in:b']);
    expect(wire(g, 's:c:out:0', 'batch:B1:in:b')).toMatchObject({ bundled: true });
    expect(wire(g, 's:d:out:0', 'batch:B1:in:b')).toMatchObject({ bundled: true });
    expect(wire(g, 's:a:out:0', 'batch:B1:in:0')).toMatchObject({ bundled: false });
  });

  it('a recorded batch whose code was not read is headed "Batch", with no stray space or id', () => {
    const data = mkData({
      samples: sam('a', 'b'),
      operations: ['a', 'b'].map((s) => mkOp({ id: `h${s}`, sampleId: s, batchId: 'B1', methodName: 'Anneal' })),
    });
    const c = container(build(data), 'batch:B1');
    expect(c.title).toBe('Batch');
    expect(c.code).toBe('');
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

  it('a family merged with plus keeps its own markers, on its own sample card (I3)', () => {
    const data = {
      ...mkData({ samples: sam('s1', 's2'), operations: [mkOp({ id: 'f1', sampleId: 's1', outputSampleId: 's2' })] }),
      mergedFamilies: [{ root: 's2', hidden: { ancestors: false, descendants: true, events: true, stock: false } }],
    };
    expect(build(data).hidden).toEqual([{ nodeId: 's:s2', side: 'out' }]);
    // both the focus family and the merged one say it; a card never gets the same marker twice
    const both = { ...data, hidden: { ancestors: false, descendants: true, events: false, stock: false } };
    expect(build(both).hidden).toEqual([
      { nodeId: 's:s1', side: 'out' },
      { nodeId: 's:s2', side: 'out' },
    ]);
    const twice = { ...data, mergedFamilies: [{ root: 's1', hidden: data.mergedFamilies[0].hidden }, ...data.mergedFamilies] };
    expect(build(twice).hidden.filter((m) => m.nodeId === 's:s1')).toHaveLength(1);
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
      } else if (n.type === 'container')
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

const DAY = '2026-09-01T09:00:00Z';

describe('buildGraph: used-in fans (D20)', () => {
  const tool = { collection: 'tools', id: 't1', code: 'TL-1', kind: 'tool' as const };
  const ref = (collection: string, id: string, code = id.toUpperCase()) => ({ collection, id, code });
  /** `n` operations that used the tool, newest first, as the loader returns them: none of their samples are loaded. */
  const toolFan = (n: number, total = n) => {
    const operations = Array.from({ length: n }, (_, i) =>
      mkOp({ id: `u${i}`, code: `OP-${i}`, methodName: 'Turning', category: 'machining', date: `2026-09-${String(28 - i).padStart(2, '0')}T09:00:00Z`, sampleId: `x${i}` }),
    );
    return mkData({ focus: tool, operations, fan: { items: operations.map((o) => ref('manufacturing_operations', o.id, o.code)), total } });
  };
  /** The page's call: collapsed fan rows are not grouped into batches. */
  const buildFan = (data: ProcessData): ProcessGraph => {
    const fanned = new Set([...(data.fan?.items ?? []), ...(data.sideFans ?? []).flatMap((f) => f.items)].map((i) => i.id));
    const rest = { ...data, operations: data.operations.filter((o) => !fanned.has(o.id)), tests: data.tests.filter((t) => !fanned.has(t.id)) };
    return buildGraph(data, groupsOf(rest, false), { slots });
  };

  it('a tool fans into collapsed containers wired from its card, and a "+N more" stub when there are more', () => {
    const g = buildFan(toolFan(20, 47));
    const root = record(g, 'f:tools:t1');
    expect(root).toMatchObject({ kind: 'tool', ref: { code: 'TL-1' }, ins: [], outs: ['f:tools:t1:out:0'] });
    const containers = g.nodes.filter((n): n is ContainerNode => n.type === 'container');
    expect(containers).toHaveLength(20);
    expect(containers.every((c) => c.collapsed === true && c.slots.length === 0 && c.settings.length === 0)).toBe(true);
    expect(containers[0]).toMatchObject({ id: 'op:u0', title: 'Turning', code: 'OP-0', meta: '2026-09-28', rows: [{ recordId: 'u0', in: 'op:u0:in:0' }] });
    expect(g.wires).toHaveLength(20);
    expect(wire(g, 'f:tools:t1:out:0', 'op:u3:in:0')).toMatchObject({ origin: 'f:tools:t1', carries: null });
    expect(g.nodes.find((n) => n.type === 'more')).toEqual({ id: 'more:tools:t1', type: 'more', of: 'tools:t1', remaining: 27 });
    // The samples the operations touched are not loaded: nothing else is drawn.
    expect(g.nodes).toHaveLength(1 + 20 + 1);
  });

  it('no stub when everything is listed; a stub counted from `remaining` when that differs from the rows (a stock lot page)', () => {
    expect(buildFan(toolFan(3)).nodes.some((n) => n.type === 'more')).toBe(false);
    const data = toolFan(0, 45);
    data.fan = { items: [], total: 45, remaining: 25 };
    expect(buildFan(data).nodes.find((n) => n.type === 'more')).toMatchObject({ remaining: 25 });
  });

  it('equipment fans into operations and tests alike', () => {
    const op = mkOp({ id: 'o1', methodName: 'Sinter', date: DAY });
    const test = mkTest({ id: 't9', testType: 'Tensile', category: 'destructive', date: '2026-09-02T09:00:00Z', status: 'done' });
    const data = mkData({
      focus: { collection: 'equipment', id: 'e1', code: 'NLX', kind: 'equipment' },
      operations: [op],
      tests: [test],
      fan: { items: [ref('test_sessions', 't9'), ref('manufacturing_operations', 'o1')], total: 2 },
    });
    const g = buildFan(data);
    expect(container(g, 'test:t9')).toMatchObject({ kind: 'test', collapsed: true, title: 'Tensile', category: 'test', status: 'done' });
    expect(container(g, 'op:o1')).toMatchObject({ kind: 'operation', collapsed: true });
    expect(wire(g, 'f:equipment:e1:out:0', 'test:t9:in:0')).toBeDefined();
  });

  it('a material fans into sample cards (no material card of their own)', () => {
    const data = mkData({
      focus: { collection: 'materials', id: 'm1', code: 'Ti64', kind: 'material' },
      samples: sam('a', 'b'),
      fan: { items: [ref('physical_samples', 'a'), ref('physical_samples', 'b')], total: 2 },
    });
    for (const s of data.samples) s.materialRef = { collection: 'materials', id: 'm1', code: 'Ti64' };
    const g = build(data);
    expect(record(g, 'f:materials:m1')).toMatchObject({ kind: 'material' });
    expect(record(g, 's:a').ins).toEqual(['s:a:in:0']);
    expect(wire(g, 'f:materials:m1:out:0', 's:a:in:0')).toBeDefined();
    expect(wire(g, 'f:materials:m1:out:0', 's:b:in:0')).toBeDefined();
    expect(g.nodes.some((n) => n.id.startsWith('m:'))).toBe(false);
  });

  it('a stock lot fan hangs from the lot card the family steps already use, not a second one', () => {
    const lot = { collection: 'raw_stock_lots', id: 'l1', code: 'LOT-1', kind: 'stock_lot' as const };
    const op = mkOp({ id: 'o1', outputSampleId: 's1' });
    const data = mkData({ focus: lot, samples: sam('s1'), operations: [op], stock: [mkStock('l1', 's1')], fan: { items: [ref('manufacturing_operations', 'o1')], total: 1 } });
    const g = build(data);
    expect(g.nodes.filter((n) => n.id === 'lot:l1')).toHaveLength(1);
    expect(record(g, 'lot:l1').outs).toEqual(['lot:l1:out:0']);
  });

  it('an item whose family is loaded is its full container, not a second collapsed one', () => {
    const op = mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: DAY, methodName: 'Cut' });
    const data = mkData({ focus: tool, samples: sam('s1', 's2'), operations: [op], fan: { items: [ref('manufacturing_operations', 'o1')], total: 1 } });
    const g = build(data);
    expect(g.nodes.filter((n) => n.type === 'container')).toHaveLength(1);
    expect(container(g, 'op:o1').collapsed).toBeUndefined();
  });

  it('side fans (a record inside the map opened with the plus button) hang beside their own card, each with its own stub', () => {
    const op = mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: DAY });
    const used = mkOp({ id: 'u1', methodName: 'Turning', date: DAY });
    const data = mkData({
      samples: sam('s1', 's2'),
      operations: [op, used],
      sideFans: [{ root: tool, items: [ref('manufacturing_operations', 'u1')], total: 30, remaining: 29 }],
    });
    const g = buildFan(data);
    expect(record(g, 'f:tools:t1')).toBeDefined();
    expect(container(g, 'op:u1').collapsed).toBe(true);
    expect(container(g, 'op:o1').collapsed).toBeUndefined();
    expect(g.nodes.find((n) => n.type === 'more')).toMatchObject({ id: 'more:tools:t1', remaining: 29 });
  });

  it('a fan focus puts the hidden-record markers on its own card, never on a sample', () => {
    const data = toolFan(2);
    data.hidden = { ancestors: false, descendants: true, events: false, stock: false };
    expect(buildFan(data).hidden).toEqual([{ nodeId: 'f:tools:t1', side: 'out' }]);
  });
});

describe('buildGraph: a family seen from one cut piece (C1)', () => {
  const DAY = '2026-03-04T09:00:00Z';
  // S was cut into A, B and C on one day; the map opened on A, so B and C are outside the family.
  const seenFromA = () =>
    mkData({
      focus: { collection: 'physical_samples', id: 'a', code: 'A', kind: 'sample' },
      samples: sam('s', 'a'),
      operations: ['a', 'b', 'c'].map((p) => mkOp({ id: `cut-${p}`, sampleId: 's', outputSampleId: p, date: DAY, methodName: 'Wire cut', equipmentId: 'eq1' })),
    });

  it('one cut container with an output per piece; the pieces outside the family are small cards', () => {
    const g = build(seenFromA(), { probable: true });
    const cuts = g.nodes.filter((n): n is ContainerNode => n.type === 'container');
    expect(cuts).toHaveLength(1);
    const c = cuts[0];
    expect(c.rows.map((r) => r.inPlace)).toEqual([undefined, undefined, undefined]);
    expect(c.rows.map((r) => r.sampleId)).toEqual(['a', 'b', 'c']);
    expect(c.rows.map((r) => r.out)).toEqual([`${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:2`]);
    expect(wire(g, `${c.id}:out:0`, 's:a:in:0')).toBeDefined();
    for (const [i, p] of ['b', 'c'].entries()) {
      expect(record(g, `s:${p}`)).toMatchObject({ kind: 'sample', ref: { collection: 'physical_samples', id: p, code: 'another piece' }, ins: [`s:${p}:in:0`] });
      expect(wire(g, `${c.id}:out:${i + 1}`, `s:${p}:in:0`)).toMatchObject({ carries: p, flow: 'sample' });
    }
  });

  it('the parent is not chained through its other pieces (no probable batch either)', () => {
    const g = build(seenFromA(), { probable: false });
    // each cut takes S in from its own card: nothing leaves one cut to feed another
    for (const p of ['a', 'b', 'c']) expect(wire(g, 's:s:out:0', `op:cut-${p}:in:0`)).toBeDefined();
    expect(g.wires.filter((w) => w.from.startsWith('op:cut-') && w.to.startsWith('op:cut-'))).toEqual([]);
    expect(g.nodes.filter((n) => n.type === 'container' && n.rows.some((r) => r.inPlace))).toEqual([]);
  });

  it('a piece outside the family shows its code when the loader found it', () => {
    const data = { ...seenFromA(), pieces: { b: { code: 'S-1B', form: 'disc' } } };
    const g = build(data, { probable: true });
    expect(record(g, 's:b').ref.code).toBe('S-1B');
    expect(record(g, 's:b').meta).toBe('disc');
    expect(record(g, 's:c').ref.code).toBe('another piece');
  });

  it('a cut whose piece is the focus stays a branch when its output is loaded', () => {
    const g = build(seenFromA(), { probable: false });
    expect(wire(g, 'op:cut-a:out:0', 's:a:in:0')).toBeDefined();
    expect(wire(g, 'op:cut-b:out:0', 's:b:in:0')).toBeDefined();
  });
});
