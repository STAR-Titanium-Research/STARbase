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
  it('reach 1 shows focus + direct neighbours', () => {
    const g = graph(chain());
    expect(ids(shownNodes(g, 's:s2', 1))).toEqual(['op:cut', 'op:pol', 's:s2']);
  });

  it('reach 2 on the in-place chain', () => {
    const g = graph(chain());
    expect(ids(shownNodes(g, 's:s2', 2))).toEqual(['op:cut', 'op:pol', 's:s1', 's:s2', 'test:hv']);
  });

  it("'all' shows everything", () => {
    const g = graph(chain());
    expect(shownNodes(g, 's:s2', 'all').size).toBe(g.nodes.length);
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

  it('a junction beside a shown sample is shown', () => {
    const data = mkData({
      samples: [mkSample('p'), mkSample('c')],
      lineage: [mkLineage('p', 'c', 'derived_from', 0.5)],
    });
    const shown = shownNodes(graph(data), 's:p', 1);
    expect(shown.has('j:p:derived_from')).toBe(true);
    expect(shown.has('s:c')).toBe(false);
  });
});
