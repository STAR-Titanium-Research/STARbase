import { describe, expect, it } from 'vitest';
import { buildGraph } from './buildGraph';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkStock, mkTest } from './fixtures';
import { shownNodes } from './reach';
import type { ProcessData } from './types';

const graph = (data: ProcessData) => buildGraph(data, groupsOf(data), { slots: () => [] });
const ids = (set: Set<string>) => [...set].sort();

/** s1 → cut → s2 → polish (in place) → hardness test (in place) → heat treatment (in place). */
function chain(): ProcessData {
  return mkData({
    samples: [mkSample('s1'), mkSample('s2')],
    operations: [
      mkOp({ id: 'cut', sampleId: 's1', outputSampleId: 's2', date: '2026-01-01', category: 'machining' }),
      mkOp({ id: 'pol', sampleId: 's2', date: '2026-01-02', category: 'sample_prep' }),
      mkOp({ id: 'ht', sampleId: 's2', date: '2026-01-04', category: 'heat_treatment' }),
    ],
    tests: [mkTest({ id: 'hv', subjectSampleIds: ['s2'], date: '2026-01-03', category: 'nde' })],
  });
}

describe('shownNodes', () => {
  it('reach 1 shows focus, the containers touching it and the samples across them', () => {
    const g = graph(chain());
    expect(ids(shownNodes(g, 's:s2', 1))).toEqual(['op:cut', 'op:pol', 's:s1', 's:s2']);
  });

  it('reach 1 from s2 reaches s1 through the cut', () => {
    expect(shownNodes(graph(chain()), 's:s2', 1).has('s:s1')).toBe(true);
  });

  it('reach 2 on the in-place chain costs one step per container', () => {
    const g = graph(chain());
    expect(ids(shownNodes(g, 's:s2', 2))).toEqual(['op:cut', 'op:pol', 's:s1', 's:s2', 'test:hv']);
    expect(ids(shownNodes(g, 's:s2', 3))).toEqual(['op:cut', 'op:ht', 'op:pol', 's:s1', 's:s2', 'test:hv']);
  });

  it('a container as focus starts with the samples it touches', () => {
    expect(ids(shownNodes(graph(chain()), 'op:cut', 0))).toEqual(['op:cut', 's:s1', 's:s2']);
  });

  it("'all' shows everything", () => {
    const g = graph(chain());
    expect(shownNodes(g, 's:s2', 'all').size).toBe(g.nodes.length);
  });

  it('a stock lot as focus shows what it feeds and the step beyond', () => {
    const data = mkData({
      samples: [mkSample('s1'), mkSample('s2')],
      operations: [mkOp({ id: 'f1', sampleId: null, outputSampleId: 's1', date: '2026-01-01' })],
      lineage: [mkLineage('s1', 's2', 'cut_from', 0.5)],
      stock: [mkStock('l1', 's1')],
    });
    const g = graph(data);
    expect(ids(shownNodes(g, 'lot:l1', 0))).toEqual(['lot:l1', 'op:f1', 's:s1']);
    expect(ids(shownNodes(g, 'lot:l1', 1))).toEqual(['j:s1:cut_from', 'lot:l1', 'op:f1', 's:s1', 's:s2']);
  });

  it('an unknown focus shows nothing', () => {
    expect(shownNodes(graph(chain()), 's:nope', 2).size).toBe(0);
  });

  it('stock lot beside a shown sample is shown, but not walked through', () => {
    const data = mkData({
      samples: [mkSample('a'), mkSample('b')],
      stock: [mkStock('l1', 'a'), mkStock('l1', 'b')],
    });
    expect(ids(shownNodes(graph(data), 's:a', 1))).toEqual(['lot:l1', 's:a']);
  });

  it('reach 1 crosses a junction to the child sample', () => {
    const data = mkData({
      samples: [mkSample('p'), mkSample('c'), mkSample('d')],
      lineage: [mkLineage('p', 'c', 'derived_from', 0.5), mkLineage('c', 'd', 'derived_from', 1)],
    });
    expect(ids(shownNodes(graph(data), 's:p', 1))).toEqual(['j:p:derived_from', 's:c', 's:p']);
    expect(shownNodes(graph(data), 's:p', 2).has('s:d')).toBe(true);
  });
});
