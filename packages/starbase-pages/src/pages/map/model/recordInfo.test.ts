import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkStock, mkTest } from './fixtures';
import { openPath, recordInfo } from './recordInfo';
import type { ProcessData, Slot } from './types';

const build = (data: ProcessData, slots: () => Slot[] = () => [], probable = false) => buildGraph(data, groupsOf(data, probable), { slots });
const fact = (info: { facts: { label: string; value?: unknown }[] } | null, label: string) => info?.facts.find((f) => f.label === label)?.value;

const data = mkData({
  samples: [
    mkSample('p', { code: 'S-1', form: 'round_bar', status: 'in_progress', facts: { Mass: '12 g', Diameter: '10 mm', Length: '40 mm' }, materialRef: { collection: 'materials', id: 'm1', code: 'Ti-6Al-4V' } }),
    mkSample('a', { code: 'S-1-A' }),
  ],
  operations: [
    mkOp({ id: 'o1', code: 'OP-1', methodName: 'Sintering', category: 'sintering', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', status: 'done', settings: {}, relations: { equipment_id: { collection: 'equipment', id: 'e1', code: 'FAST 25' } } }),
  ],
  tests: [mkTest({ id: 't1', code: 'T-1', testType: 'tensile', date: '2026-09-05T09:00:00Z', subjectSampleIds: ['a'], status: 'complete' })],
  stock: [mkStock('l1', 'p', { lotCode: 'LOT-9', supplier: 'Acme', massUsedGrams: 12.5 })],
});
const slots = (): Slot[] => [{ field: 'equipment_id', role: 'Machine', ref: { collection: 'equipment', id: 'e1', code: 'FAST 25' }, major: true }];
const graph = build(data, slots);
const opNode = graph.nodes.find((n) => n.type === 'container' && n.kind === 'operation')!;

describe('recordInfo', () => {
  it('a sample: code, status, form, its facts, the row the drawing reads, and counts', () => {
    const info = recordInfo(data, graph, 's:p')!;
    expect(info).toMatchObject({ kind: 'sample', code: 'S-1', status: 'in_progress', ref: { collection: 'physical_samples', id: 'p' } });
    expect(info.title).toBe('Round bar');
    expect(fact(info, 'Mass')).toBe('12 g');
    expect(fact(info, 'Material')).toBe('Ti-6Al-4V');
    expect(info.geometry).toEqual({ form: 'round_bar', diameter_mm: 10, length_mm: 40 });
    expect(info.counts).toContainEqual({ value: 1, label: 'operations' });
    expect(info.dataOf).toBeNull();
  });

  it('an operation: method, process, date, machine, and the data to ask about', () => {
    const info = recordInfo(data, graph, opNode.id)!;
    expect(info).toMatchObject({ kind: 'operation', code: 'OP-1', status: 'done', ref: { collection: 'manufacturing_operations', id: 'o1', code: 'OP-1' } });
    expect(info.title).toBe('Sintering');
    expect(fact(info, 'Process')).toBe('FAST sintering');
    expect(fact(info, 'Date')).toBe('1 Sept 2026');
    expect(fact(info, 'Machine')).toBe('FAST 25');
    expect(info.dataOf).toEqual({ collection: 'manufacturing_operations', id: 'o1', code: 'OP-1' });
  });

  it('a test: type and date, no data to ask about', () => {
    const t = graph.nodes.find((n) => n.type === 'container' && n.kind === 'test')!;
    const info = recordInfo(data, graph, t.id)!;
    expect(info).toMatchObject({ kind: 'test', code: 'T-1', ref: { collection: 'test_sessions', id: 't1' } });
    expect(fact(info, 'Type')).toBe('tensile');
    expect(info.dataOf).toBeNull();
  });

  it('a stock lot: supplier, the mass used, the samples it fed', () => {
    const info = recordInfo(data, graph, 'lot:l1')!;
    expect(info).toMatchObject({ kind: 'stock_lot', code: 'LOT-9', ref: { collection: 'raw_stock_lots', id: 'l1' } });
    expect(fact(info, 'Supplier')).toBe('Acme');
    expect(fact(info, 'Mass used')).toBe('12.5 g');
    expect(info.counts).toContainEqual({ value: 1, label: 'samples' });
  });

  it('a probable batch is described, not named by one operation code', () => {
    const many = mkData({
      samples: [mkSample('p'), mkSample('a'), mkSample('b')],
      operations: [
        mkOp({ id: 'x1', code: 'X-1', methodName: 'Cut', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', equipmentId: 'e1' }),
        mkOp({ id: 'x2', code: 'X-2', methodName: 'Cut', sampleId: 'p', outputSampleId: 'b', date: '2026-09-01T09:05:00Z', equipmentId: 'e1' }),
      ],
    });
    const g = build(many, () => [], true);
    const node = g.nodes.find((n) => n.type === 'container' && n.probable)!;
    const info = recordInfo(many, g, node.id)!;
    expect(info.code).toBe('Probable batch · Cut');
    expect(info.plain).toBe(true);
    expect(fact(info, 'Operations')).toBe(2);
  });

  it('a junction is described by its lineage and opens the parent sample', () => {
    const d = mkData({ samples: [mkSample('s'), mkSample('a')], lineage: [mkLineage('s', 'a', 'cut_from', 0.5)] });
    const g = build(d);
    const j = g.nodes.find((n) => n.type === 'junction')!;
    const info = recordInfo(d, g, j.id)!;
    expect(info).toMatchObject({ kind: 'junction', code: 'Cut from', plain: true, ref: { collection: 'physical_samples', id: 's' } });
  });

  it('a record inside a card: its kind and how many steps use it', () => {
    const info = recordInfo(data, graph, 'equipment:e1')!;
    expect(info).toMatchObject({ kind: 'equipment', code: 'FAST 25', ref: { collection: 'equipment', id: 'e1' } });
    expect(info.counts).toContainEqual({ value: 2, label: 'steps' }); // the operation and the test both carry it
  });

  it('an id the map does not know has no info', () => {
    expect(recordInfo(data, graph, 'nope')).toBeNull();
  });
});

describe('recordInfo: a family seen from one cut piece (C1)', () => {
  const DAY = '2026-03-04T09:00:00Z';
  const seen = mkData({
    focus: { collection: 'physical_samples', id: 'a', code: 'A', kind: 'sample' },
    samples: [mkSample('s'), mkSample('a')],
    operations: ['a', 'b', 'c'].map((p) => mkOp({ id: `cut-${p}`, sampleId: 's', outputSampleId: p, date: DAY, methodName: 'Cut', equipmentId: 'saw' })),
  });
  const g = build(seen, () => [], true);

  it('the parent says it made the 3 pieces the drawing shows', () => {
    const info = recordInfo(seen, g, 's:s')!;
    expect(info.counts).toContainEqual({ value: 3, label: 'pieces' });
    expect(g.nodes.filter((n) => n.type === 'record' && n.kind === 'sample').length - 1).toBe(3); // the parent is the fourth card
  });

  it('a piece outside the family still has a card to hover: its code and the way to open it', () => {
    const info = recordInfo(seen, g, 's:b')!;
    expect(info).toMatchObject({ kind: 'sample', code: 'another piece', ref: { collection: 'physical_samples', id: 'b' } });
  });
});

describe('recordInfo: where Open record goes (I4)', () => {
  const forceFile = { collection: 'force_file', id: 'D:\lab\run 3\cut.mat', code: 'cut.mat' };
  const upload = { collection: 'directus_files', id: 'f1', code: 'trace.csv' };
  const d = mkData({
    samples: [mkSample('p'), mkSample('a')],
    operations: [
      mkOp({ id: 'o1', category: 'machining', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', relations: { force_file_id: forceFile } }),
    ],
    tests: [mkTest({ id: 't1', subjectSampleIds: ['a'], date: '2026-09-05T09:00:00Z', relations: { session_data_files: upload } })],
  });
  const slotsOf = (row: { relations: Record<string, unknown> }, kind: 'operation' | 'test'): Slot[] =>
    kind === 'operation'
      ? [{ field: 'force_file_id', role: 'Force data', ref: forceFile, major: false }]
      : [{ field: 'session_data_files', role: 'Data', ref: upload, major: false }];
  const g = buildGraph(d, groupsOf(d, false), { slots: (row, kind) => slotsOf(row, kind) });

  it('Force data opens the operation in the Force dashboard, not a Data Studio page that does not exist', () => {
    const info = recordInfo(d, g, `force_file:${forceFile.id}`)!;
    expect(info.ref).toEqual(forceFile);
    expect(openPath(info)).toBe('/d1-force-dashboard?operation=o1');
  });

  it('a data file opens in the file library', () => {
    expect(openPath(recordInfo(d, g, 'directus_files:f1')!)).toBe('/files/f1');
  });

  it('every other record opens its record page', () => {
    expect(openPath(recordInfo(d, g, 's:p')!)).toBe('/home/samples/p');
  });

  it('Force data whose operation is not on the map has nowhere to open', () => {
    const lone = buildGraph(d, groupsOf(d, false), { slots: (row, kind) => (kind === 'operation' ? [{ field: 'force_file_id', role: 'Force data', ref: { ...forceFile, id: 'elsewhere.mat' }, major: false }] : []) });
    expect(openPath(recordInfo(d, lone, 'force_file:elsewhere.mat')!)).toBeNull();
  });
});
