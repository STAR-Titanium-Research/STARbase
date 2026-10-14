import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { fanData, fanNodeIds, fanPage, fanRowIds, focusPlan, hasFan, mergeProcessData, recordWord, withFanPage, withSideFan } from './fans';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkStock, mkTest } from './fixtures';
import type { UsedIn } from './loadFamily';
import type { ProcessData, Ref } from './types';

const ref = (collection: string, id: string, code = id.toUpperCase()): Ref => ({ collection, id, code });
const tool = { collection: 'tools', id: 't1', code: 'TL-1', kind: 'tool' as const };
const ops = (n: number, from = 0) => Array.from({ length: n }, (_, i) => mkOp({ id: `u${from + i}`, date: `2026-09-${String(28 - from - i).padStart(2, '0')}T09:00:00Z`, sampleId: `x${from + i}` }));

describe('focusPlan (D20)', () => {
  it('samples open their family, operations and tests open through their sample, the rest fan, anything else cannot open', () => {
    expect(focusPlan('physical_samples')).toBe('sample');
    expect(focusPlan('manufacturing_operations')).toBe('step');
    expect(focusPlan('test_sessions')).toBe('step');
    for (const c of ['tools', 'equipment', 'insert_edges', 'fast_recipes', 'prep_recipes', 'raw_stock_lots', 'materials', 'projects', 'campaigns']) expect(focusPlan(c)).toBe('fan');
    for (const c of ['widgets', 'people', 'directus_files', 'force_file', 'sample_genealogy']) expect(focusPlan(c)).toBeNull();
  });

  it('only collections with a fan offer one for a record inside the map', () => {
    expect(hasFan('tools')).toBe(true);
    expect(hasFan('people')).toBe(false);
    expect(hasFan('directus_files')).toBe(false);
    expect(hasFan('physical_samples')).toBe(false);
  });

  it('names a record in the page words', () => {
    expect(recordWord('equipment')).toEqual({ one: 'machine', many: 'Machines' });
    expect(recordWord('nothing')).toEqual({ one: 'record', many: 'Records' });
  });
});

describe('fanPage: "+N more" is counted from the server total and the pages read', () => {
  const used = (items: UsedIn['items'], total: number, extra: Partial<UsedIn> = {}): UsedIn => ({ items, total, ...extra });

  it('operations of a tool: refs in the order read, remaining = total - 20 per page', () => {
    const page = fanPage('tools', used(ops(20), 47), 1);
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toMatchObject({ collection: 'manufacturing_operations', id: 'u0' });
    expect(page.remaining).toBe(27);
    expect(fanPage('tools', used(ops(20, 20), 47), 2).remaining).toBe(7);
    expect(fanPage('tools', used(ops(7, 40), 47), 3).remaining).toBe(0);
  });

  it('a stock lot page can hold no operations at all and still have more: the total counts samples', () => {
    const page = fanPage('raw_stock_lots', used([], 45), 1);
    expect(page.items).toEqual([]);
    expect(page.remaining).toBe(25);
  });

  it('equipment: operations and tests interleaved newest first; more is the larger of the two lists', () => {
    const op = mkOp({ id: 'o1', date: '2026-09-01T09:00:00Z' });
    const test = mkTest({ id: 't1', date: '2026-09-03T09:00:00Z' });
    const page = fanPage('equipment', used([op], 30, { tests: [test], testsTotal: 75 }), 1);
    expect(page.items.map((i) => i.id)).toEqual(['t1', 'o1']);
    expect(page.remaining).toBe(55);
  });

  it('samples of a material, project or campaign are cards', () => {
    const page = fanPage('campaigns', used([mkSample('a'), mkSample('b')], 2), 1);
    expect(page.samples).toHaveLength(2);
    expect(page.items.map((i) => i.collection)).toEqual(['physical_samples', 'physical_samples']);
    expect(page.remaining).toBe(0);
  });
});

describe('fanData and withFanPage', () => {
  it('a first page becomes the focus fan; the next page appends without listing a row twice', () => {
    const first = fanData(tool, fanPage('tools', { items: ops(20), total: 30 }, 1));
    expect(first.focus).toMatchObject({ collection: 'tools', kind: 'tool' });
    expect(first.fan?.items).toHaveLength(20);
    expect(first.fan?.remaining).toBe(10);
    expect(first.operations).toHaveLength(20);

    const next = withFanPage(first, 'tools:t1', fanPage('tools', { items: [...ops(1, 19), ...ops(10, 20)], total: 30 }, 2));
    expect(next.fan?.items).toHaveLength(30);
    expect(new Set(next.fan?.items.map((i) => i.id)).size).toBe(30);
    expect(next.operations).toHaveLength(30);
    expect(next.fan?.remaining).toBe(0);
  });

  it('a record the map already holds in full (its family is loaded) is not listed as a collapsed item', () => {
    const family = mkData({ samples: [mkSample('s1')], operations: [mkOp({ id: 'u0', sampleId: 's1' })] });
    const side = withSideFan(family, tool, fanPage('tools', { items: ops(2), total: 2 }, 1));
    expect(side.sideFans?.[0].items.map((i) => i.id)).toEqual(['u1']);
  });

  it('a side fan is its own list: paging it leaves the others alone', () => {
    const base = mkData({ samples: [mkSample('s1')] });
    const a = withSideFan(base, tool, fanPage('tools', { items: ops(20), total: 40 }, 1));
    const b = withSideFan(a, { collection: 'equipment', id: 'e1', code: 'NLX', kind: 'equipment' }, fanPage('equipment', { items: [mkOp({ id: 'e-op' })], total: 1 }, 1));
    const paged = withFanPage(b, 'tools:t1', fanPage('tools', { items: ops(20, 20), total: 40 }, 2));
    expect(paged.sideFans?.[0].items).toHaveLength(40);
    expect(paged.sideFans?.[1].items).toHaveLength(1);
  });
});

describe('mergeProcessData', () => {
  const family = (): ProcessData =>
    mkData({
      samples: [mkSample('s1'), mkSample('s2')],
      operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z' })],
      tests: [mkTest({ id: 't1', subjectSampleIds: ['s2'] })],
      lineage: [mkLineage('s1', 's2')],
      stock: [mkStock('l1', 's1')],
    });

  it('de-duplicates by id and keeps the base focus and hidden flags', () => {
    const base = { ...family(), hidden: { ancestors: true, descendants: false, events: false, stock: false } };
    const add = { ...family(), focus: { collection: 'physical_samples', id: 'zzz', code: 'ZZZ', kind: 'sample' as const }, hidden: { ancestors: false, descendants: true, events: true, stock: true }, truncated: true };
    add.samples.push(mkSample('s3'));
    add.operations.push(mkOp({ id: 'o2', sampleId: 's2', outputSampleId: 's3' }));
    add.lineage.push(mkLineage('s2', 's3'));
    const merged = mergeProcessData(base, add);
    expect(merged.samples.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(merged.operations.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(merged.tests).toHaveLength(1);
    expect(merged.lineage).toHaveLength(2);
    expect(merged.stock).toHaveLength(1);
    expect(merged.focus.id).toBe('s1');
    expect(merged.hidden).toEqual(base.hidden);
    expect(merged.truncated).toBe(true);
  });

  it('drops the fan items the family now holds in full, in the focus fan and in side fans', () => {
    const fanOps = [mkOp({ id: 'u0', sampleId: 'x0' }), mkOp({ id: 'u1', sampleId: 'x1' })];
    const base = withSideFan(fanData(tool, fanPage('tools', { items: fanOps, total: 2 }, 1)), { collection: 'equipment', id: 'e1', code: 'NLX', kind: 'equipment' }, fanPage('equipment', { items: [mkOp({ id: 'e1op' })], total: 1 }, 1));
    const add = mkData({ samples: [mkSample('x0')], operations: [mkOp({ id: 'u0', sampleId: 'x0' }), mkOp({ id: 'e1op', sampleId: 'x0' })] });
    const merged = mergeProcessData(base, add);
    expect(merged.fan?.items.map((i) => i.id)).toEqual(['u1']);
    expect(merged.sideFans?.[0].items).toEqual([]);
    expect([...fanRowIds(merged)]).toEqual(['u1']);
    // u0 is one row, whichever way it was read.
    expect(merged.operations.filter((o) => o.id === 'u0')).toHaveLength(1);
  });

  it('merging a family into a graph draws no node twice, and the opened step is its full container', () => {
    const base = fanData(tool, fanPage('tools', { items: [mkOp({ id: 'u0', sampleId: 's1', date: '2026-09-01T09:00:00Z' }), mkOp({ id: 'u1', sampleId: 'x1', date: '2026-09-02T09:00:00Z' })], total: 2 }, 1));
    const add = mkData({ samples: [mkSample('s1'), mkSample('s2')], operations: [mkOp({ id: 'u0', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })] });
    const merged = mergeProcessData(base, add);
    const collapsed = fanRowIds(merged);
    const rest = { ...merged, operations: merged.operations.filter((o) => !collapsed.has(o.id)), tests: [] };
    const g = buildGraph(merged, groupsOf(rest, false), { slots: () => [] });
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.nodes.find((n) => n.id === 'op:u0')).toMatchObject({ type: 'container' });
    expect(g.nodes.find((n) => n.id === 'op:u0')).not.toHaveProperty('collapsed', true);
    expect(g.nodes.find((n) => n.id === 'op:u1')).toMatchObject({ collapsed: true });
  });
});

describe('fanNodeIds', () => {
  it('lists the record, the listed items and the stub that are drawn', () => {
    const data = fanData(tool, fanPage('tools', { items: ops(3), total: 50 }, 1));
    const g = buildGraph(data, [], { slots: () => [] });
    expect([...fanNodeIds(data, g)].sort()).toEqual(['f:tools:t1', 'more:tools:t1', 'op:u0', 'op:u1', 'op:u2']);
  });
});
