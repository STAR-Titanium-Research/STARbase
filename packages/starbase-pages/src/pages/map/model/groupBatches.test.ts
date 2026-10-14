import { describe, expect, it } from 'vitest';
import { groupBatches } from './groupBatches';
import type { Group, OpRow, ProcessCategory, TestRow } from './types';

let n = 0;
function op(p: Partial<OpRow> = {}): OpRow {
  n += 1;
  return {
    id: `op${n}`,
    code: `OP-${n}`,
    methodId: 'm1',
    methodName: 'Method',
    category: null,
    date: null,
    sequence: null,
    status: null,
    sampleId: null,
    outputSampleId: null,
    equipmentId: null,
    recipeKey: null,
    batchId: null,
    sourceRunUid: null,
    powderBatch: null,
    relations: {},
    settings: {},
    projectId: null,
    ...p,
  };
}

function test(p: Partial<TestRow> = {}): TestRow {
  n += 1;
  return {
    id: `t${n}`,
    code: `T-${n}`,
    testType: null,
    category: null,
    date: null,
    status: null,
    subjectSampleIds: [],
    equipmentId: null,
    batchId: null,
    relations: {},
    settings: {},
    projectId: null,
    ...p,
  };
}

const DAY = '2026-03-04T09:00:00Z';
const LATER_SAME_DAY = '2026-03-04T15:30:00Z';
const NEXT_DAY = '2026-03-05T09:00:00Z';

/** Four rows of one category on four different input samples, same method, machine, day and recipe. */
function fourSamples(category: ProcessCategory): OpRow[] {
  return [1, 2, 3, 4].map((i) =>
    op({
      category,
      sampleId: `s${i}`,
      equipmentId: 'eq1',
      recipeKey: 'r1',
      date: i % 2 ? DAY : LATER_SAME_DAY,
    }),
  );
}

const multi = (groups: Group[]) => groups.filter((g) => g.rowIds.length > 1);
const sizes = (groups: Group[]) => groups.map((g) => g.rowIds.length).sort();

describe('groupBatches', () => {
  it('13 sintering runs, one day, one recipe, one powder batch → 13 single groups', () => {
    const runs = Array.from({ length: 13 }, (_, i) =>
      op({
        category: 'sintering',
        sampleId: `s${i}`,
        equipmentId: 'fast',
        recipeKey: 'r1',
        powderBatch: 'TIMET 45-150',
        date: DAY,
        sourceRunUid: `run-${i}`,
      }),
    );
    const groups = groupBatches(runs, [], { probable: true });
    expect(groups).toHaveLength(13);
    expect(groups.every((g) => g.rowIds.length === 1 && g.batch === null)).toBe(true);

    const noUid = runs.map((r) => ({ ...r, id: `${r.id}x`, sourceRunUid: null }));
    const again = groupBatches(noUid, [], { probable: true });
    expect(again).toHaveLength(13);
    expect(multi(again)).toHaveLength(0);
  });

  it('rows with a source_run_uid never join a probable group, even from one sample', () => {
    const rows = [1, 2].map((i) =>
      op({ category: 'machining', sampleId: 's1', equipmentId: 'eq', date: DAY, sourceRunUid: `u${i}` }),
    );
    expect(multi(groupBatches(rows, [], { probable: true }))).toHaveLength(0);
  });

  it('4 cuts from one sample on one day → one group of 4, batch {recorded:false}', () => {
    const cuts = [1, 2, 3, 4].map((i) =>
      op({
        category: 'machining',
        sampleId: 'parent',
        outputSampleId: `piece${i}`,
        equipmentId: 'saw',
        date: i < 3 ? DAY : LATER_SAME_DAY,
      }),
    );
    const groups = groupBatches(cuts, [], { probable: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'operation', batch: { recorded: false } });
    expect(groups[0]?.rowIds).toEqual(cuts.map((c) => c.id));
    expect(groups[0]?.id).toBe(`probable:${cuts.map((c) => c.id).sort().join(',')}`);
  });

  it('4 polishing rows on 4 samples, same day, machine, recipe → one probable group', () => {
    const groups = groupBatches(fourSamples('sample_prep'), [], { probable: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.batch).toEqual({ recorded: false });
    expect(groups[0]?.rowIds).toHaveLength(4);
  });

  it('the same 4 rows on a lathe (machining, different samples) → 4 singles', () => {
    const groups = groupBatches(fourSamples('machining'), [], { probable: true });
    expect(groups).toHaveLength(4);
    expect(multi(groups)).toHaveLength(0);
    expect(groups.every((g) => g.batch === null && g.id.startsWith('op:'))).toBe(true);
  });

  it('heat_treatment and additive group like sample_prep; deformation does not', () => {
    expect(multi(groupBatches(fourSamples('heat_treatment'), [], { probable: true }))).toHaveLength(1);
    expect(multi(groupBatches(fourSamples('additive'), [], { probable: true }))).toHaveLength(1);
    expect(multi(groupBatches(fourSamples('deformation'), [], { probable: true }))).toHaveLength(0);
    expect(multi(groupBatches(fourSamples('sintering'), [], { probable: true }))).toHaveLength(0);
    expect(multi(groupBatches(fourSamples(null), [], { probable: true }))).toHaveLength(0);
  });

  it('a different day, machine, method or recipe splits a sample_prep group', () => {
    const rows = fourSamples('sample_prep');
    const byDay = rows.map((r, i) => (i === 3 ? { ...r, date: NEXT_DAY } : r));
    expect(sizes(groupBatches(byDay, [], { probable: true }))).toEqual([1, 3]);

    const byRecipe = rows.map((r, i) => (i < 2 ? { ...r, recipeKey: 'r2' } : r));
    expect(sizes(groupBatches(byRecipe, [], { probable: true }))).toEqual([2, 2]);

    const byEquipment = rows.map((r, i) => (i === 0 ? { ...r, equipmentId: 'eq2' } : r));
    expect(sizes(groupBatches(byEquipment, [], { probable: true }))).toEqual([1, 3]);

    const byMethod = rows.map((r, i) => (i === 0 ? { ...r, methodId: 'm2' } : r));
    expect(sizes(groupBatches(byMethod, [], { probable: true }))).toEqual([1, 3]);
  });

  it('blank recipe equals blank', () => {
    const rows = fourSamples('sample_prep').map((r) => ({ ...r, recipeKey: null }));
    const groups = groupBatches(rows, [], { probable: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rowIds).toHaveLength(4);
    const mixed = rows.map((r, i) => (i === 0 ? { ...r, recipeKey: 'r1' } : r));
    expect(sizes(groupBatches(mixed, [], { probable: true }))).toEqual([1, 3]);
  });

  it('the day is the UTC calendar day of the date', () => {
    const a = op({ category: 'sample_prep', sampleId: 's1', date: '2026-03-04T23:30:00Z' });
    const b = op({ category: 'sample_prep', sampleId: 's2', date: '2026-03-04T00:15:00Z' });
    const c = op({ category: 'sample_prep', sampleId: 's3', date: '2026-03-05T00:15:00Z' });
    expect(sizes(groupBatches([a, b, c], [], { probable: true }))).toEqual([1, 2]);
  });

  it('rows without a date never join a probable group', () => {
    const rows = fourSamples('sample_prep').map((r) => ({ ...r, date: null }));
    expect(multi(groupBatches(rows, [], { probable: true }))).toHaveLength(0);
  });

  it('a recorded batch_id groups any category and wins; header code from batchCodes', () => {
    const lathe = fourSamples('machining').map((r) => ({ ...r, batchId: 'b1' }));
    const groups = groupBatches(lathe, [], { probable: false, batchCodes: { b1: 'B-0001' } });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'batch:b1',
      kind: 'operation',
      batch: { recorded: true, code: 'B-0001' },
    });
    expect(groups[0]?.rowIds).toHaveLength(4);

    // A batch whose code was not read is still a batch: grouped by id, with no code to show.
    const noCode = groupBatches(lathe, [], { probable: true });
    expect(noCode[0]).toMatchObject({ id: 'batch:b1', batch: { recorded: true, code: null } });
  });

  it('rows with a batchId never join a probable group', () => {
    const rows = fourSamples('sample_prep');
    const recorded = { ...rows[0]!, batchId: 'b9' };
    const groups = groupBatches([recorded, ...rows.slice(1)], [], { probable: true });
    const rec = groups.find((g) => g.id === 'batch:b9');
    expect(rec?.rowIds).toEqual([recorded.id]);
    const prob = groups.find((g) => g.batch && !g.batch.recorded);
    expect(prob?.rowIds).toEqual(rows.slice(1).map((r) => r.id));
  });

  it('probable:false → only recorded groups', () => {
    const rows = [
      ...fourSamples('sample_prep'),
      ...[1, 2].map((i) =>
        op({ category: 'machining', sampleId: 'p', outputSampleId: `c${i}`, equipmentId: 'saw', date: DAY }),
      ),
      op({ batchId: 'b2' }),
      op({ batchId: 'b2' }),
    ];
    const groups = groupBatches(rows, [], { probable: false });
    expect(multi(groups)).toHaveLength(1);
    expect(multi(groups)[0]?.id).toBe('batch:b2');
    expect(groups).toHaveLength(1 + rows.length - 2);
  });

  it('tests group only by batchId', () => {
    const same = [1, 2, 3].map(() =>
      test({ category: 'nde', date: DAY, equipmentId: 'xray', subjectSampleIds: ['s1'] }),
    );
    const g1 = groupBatches([], same, { probable: true });
    expect(g1).toHaveLength(3);
    expect(g1.every((g) => g.kind === 'test' && g.batch === null && g.id.startsWith('test:'))).toBe(true);

    const rec = [test({ batchId: 'tb' }), test({ batchId: 'tb' }), test()];
    const g2 = groupBatches([], rec, { probable: true, batchCodes: { tb: 'B-0007' } });
    expect(g2).toHaveLength(2);
    expect(g2[0]).toMatchObject({ id: 'batch:tb', kind: 'test', batch: { recorded: true, code: 'B-0007' } });
  });

  it('a batch with 2 operations and 1 test is one operation group and one test group, both headed by the code', () => {
    const ops = [op({ batchId: 'b3' }), op({ batchId: 'b3' })];
    const t = [test({ batchId: 'b3' })];
    const groups = groupBatches(ops, t, { probable: true, batchCodes: { b3: 'B-0003' } });
    expect(groups.map((g) => [g.id, g.kind, g.rowIds.length])).toEqual([
      ['batch:b3', 'operation', 2],
      ['batch:b3:test', 'test', 1],
    ]);
    expect(groups.every((g) => g.batch?.recorded && g.batch.code === 'B-0003')).toBe(true);
  });

  it('an operation batch and a test batch with the same id stay separate groups with distinct ids', () => {
    const groups = groupBatches([op({ batchId: 'x' })], [test({ batchId: 'x' })], { probable: true });
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
    expect(groups.map((g) => g.kind).sort()).toEqual(['operation', 'test']);
  });

  it('every input row appears in exactly one group', () => {
    const ops = [
      ...fourSamples('sample_prep'),
      ...fourSamples('machining'),
      ...[1, 2, 3].map((i) =>
        op({ category: 'machining', sampleId: 'p', outputSampleId: `c${i}`, equipmentId: 'saw', date: DAY }),
      ),
      op({ batchId: 'b1' }),
      op({ batchId: 'b1', category: 'sintering', sourceRunUid: 'u' }),
      op({ sourceRunUid: 'u2' }),
      op(),
    ];
    const tests = [test({ batchId: 'tb' }), test({ batchId: 'tb' }), test()];
    for (const probable of [true, false]) {
      const groups = groupBatches(ops, tests, { probable });
      const seen = groups.flatMap((g) => g.rowIds);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...ops, ...tests].map((r) => r.id).sort());
      expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
    }
  });

  it('in-place passes on one sample on one day are never a probable batch (I1)', () => {
    const passes = [1, 2, 3].map(() => op({ category: 'machining', sampleId: 's1', outputSampleId: null, equipmentId: 'lathe', date: DAY }));
    const groups = groupBatches(passes, [], { probable: true });
    expect(groups).toHaveLength(3);
    expect(multi(groups)).toHaveLength(0);
    // an output that is the input itself is still in place
    const same = [1, 2].map(() => op({ category: 'machining', sampleId: 's1', outputSampleId: 's1', equipmentId: 'lathe', date: DAY }));
    expect(multi(groupBatches(same, [], { probable: true }))).toHaveLength(0);
  });

  it('several passes on ONE sample (polishing, heat treatment) are a sequence, not "several samples together" (I1)', () => {
    for (const category of ['sample_prep', 'heat_treatment', 'additive'] as const) {
      const passes = [1, 2, 3].map(() => op({ category, sampleId: 's1', equipmentId: 'polisher', recipeKey: 'r1', date: DAY }));
      const groups = groupBatches(passes, [], { probable: true });
      expect(groups, category).toHaveLength(3);
      expect(multi(groups), category).toHaveLength(0);
    }
    // two samples among them are still together
    const mixed = [op({ category: 'sample_prep', sampleId: 's1', equipmentId: 'p', date: DAY }), op({ category: 'sample_prep', sampleId: 's2', equipmentId: 'p', date: DAY })];
    expect(multi(groupBatches(mixed, [], { probable: true }))).toHaveLength(1);
    // additive builds from powder have no input sample: their outputs are the samples
    const builds = [1, 2].map((i) => op({ category: 'additive', sampleId: null, outputSampleId: `b${i}`, equipmentId: 'slm', date: DAY }));
    expect(multi(groupBatches(builds, [], { probable: true }))).toHaveLength(1);
  });

  it('the same-input rule needs a known input sample', () => {
    const rows = [1, 2].map(() => op({ category: 'machining', sampleId: null, equipmentId: 'saw', date: DAY }));
    expect(multi(groupBatches(rows, [], { probable: true }))).toHaveLength(0);
  });
});
