import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { connectionCount, connectionsOf, orderedGroups } from './connections';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkStock } from './fixtures';
import type { ProcessData, Ref, Slot } from './types';

const DAY = '2026-09-01T09:00:00Z';
const build = (data: ProcessData, slots: () => Slot[] = () => []) => buildGraph(data, groupsOf(data), { slots });
const ref = (collection: string, id: string, code: string): Ref => ({ collection, id, code });
const ids = (list: { nodeId: string }[] | undefined) => (list ?? []).map((e) => e.nodeId);

// p --Cut (o1)--> a ; p --Polish (o2, in place)--> p ; a --Sinter (o3)--> b
const chain = () =>
  mkData({
    samples: [mkSample('p'), mkSample('a'), mkSample('b')],
    operations: [
      mkOp({ id: 'o1', code: 'OP-1', methodName: 'Cut', sampleId: 'p', outputSampleId: 'a', date: DAY }),
      mkOp({ id: 'o3', code: 'OP-3', methodName: 'Sinter', sampleId: 'a', outputSampleId: 'b', date: '2026-09-02T09:00:00Z' }),
    ],
  });

describe('connectionsOf', () => {
  it('a sample: came in from the operation that made it, went on to the next step', () => {
    const g = build(chain());
    const c = connectionsOf(g, 's:a');
    expect(c['Came in from']).toEqual([{ collection: 'manufacturing_operations', id: 'o1', code: 'OP-1', label: 'Cut', nodeId: g.nodes.find((n) => n.type === 'container' && n.code === 'OP-1')!.id }]);
    expect(c['Went on to']?.map((e) => e.code)).toEqual(['OP-3']);
    expect(Object.keys(c).sort()).toEqual(['Came in from', 'Went on to']);
  });

  it('omits empty groups', () => {
    const g = build(mkData({ samples: [mkSample('p')] }));
    expect(connectionsOf(g, 's:p')).toEqual({});
  });

  it('the first sample has no "came in from" but the step it went on to', () => {
    const c = connectionsOf(build(chain()), 's:p');
    expect(c['Came in from']).toBeUndefined();
    expect(c['Went on to']?.map((e) => e.code)).toEqual(['OP-1']);
  });

  it('passes a junction through to the sample on the other side, labelled with the lineage', () => {
    const g = build(mkData({ samples: [mkSample('s'), mkSample('a'), mkSample('b')], lineage: [mkLineage('s', 'a', 'cut_from', 0.5), mkLineage('s', 'b', 'cut_from', 0.5)] }));
    const down = connectionsOf(g, 's:s');
    expect(down['Went on to']).toEqual([
      { collection: 'physical_samples', id: 'a', code: 'A', label: 'cut into', nodeId: 's:a' },
      { collection: 'physical_samples', id: 'b', code: 'B', label: 'cut into', nodeId: 's:b' },
    ]);
    const up = connectionsOf(g, 's:a');
    expect(up['Came in from']).toEqual([{ collection: 'physical_samples', id: 's', code: 'S', label: 'cut from', nodeId: 's:s' }]);
    // Never the junction itself.
    expect(ids(up['Came in from']).some((i) => i.startsWith('j:'))).toBe(false);
  });

  it('a container: the samples in and out, and what is Inside', () => {
    const g = build(chain(), () => [
      { field: 'equipment_id', role: 'Machine', ref: ref('equipment', 'e1', 'Mill 1'), major: true },
      { field: 'tool_id', role: 'Tool', ref: ref('tools', 't1', 'T-1'), major: true },
    ]);
    const op = g.nodes.find((n) => n.type === 'container' && n.code === 'OP-1')!;
    const c = connectionsOf(g, op.id);
    expect(c['Came in from']?.map((e) => e.code)).toEqual(['P']);
    expect(c['Went on to']?.map((e) => e.code)).toEqual(['A']);
    expect(c['Inside']).toEqual([
      { ...ref('equipment', 'e1', 'Mill 1'), label: 'Machine', nodeId: 'equipment:e1' },
      { ...ref('tools', 't1', 'T-1'), label: 'Tool', nodeId: 'tools:t1' },
    ]);
  });

  it('a slot record: used in every container that holds it, once', () => {
    const g = build(chain(), () => [{ field: 'equipment_id', role: 'Machine', ref: ref('equipment', 'e1', 'Mill 1'), major: true }]);
    const c = connectionsOf(g, 'equipment:e1');
    expect(c['Used in']?.map((e) => e.code)).toEqual(['OP-1', 'OP-3']);
    expect(Object.keys(c)).toEqual(['Used in']);
  });

  it('a project in a slot also lists the samples of that project', () => {
    const data = chain();
    data.samples[0].projectId = 'pr1';
    data.samples[1].projectId = 'pr1';
    const g = build(data, () => [{ field: 'project_id', role: 'Project', ref: ref('projects', 'pr1', 'PR-1'), major: false }]);
    const c = connectionsOf(g, 'projects:pr1');
    expect(c['In this project']?.map((e) => e.code)).toEqual(['P', 'A']);
    expect(c['Used in']).toHaveLength(2);
  });

  it('a stock lot went on to the sample it fed', () => {
    const data = mkData({ samples: [mkSample('p')], stock: [mkStock('l1', 'p', { lotCode: 'LOT-1' })] });
    const c = connectionsOf(build(data), 'lot:l1');
    expect(c['Went on to']?.map((e) => e.code)).toEqual(['P']);
    expect(connectionsOf(build(data), 's:p')['Came in from']?.map((e) => e.code)).toEqual(['LOT-1']);
  });

  it('an unknown id has no connections', () => {
    expect(connectionsOf(build(chain()), 'nope')).toEqual({});
  });
});

describe('connection helpers', () => {
  it('counts and orders the groups the way the rail shows them', () => {
    const c = connectionsOf(build(chain()), 's:a');
    expect(connectionCount(c)).toBe(2);
    expect(orderedGroups(c).map((g) => g.group)).toEqual(['Came in from', 'Went on to']);
  });
});
