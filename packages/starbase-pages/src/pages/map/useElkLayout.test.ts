import { describe, expect, it } from 'vitest';
import { useElkLayout } from './useElkLayout';
import type { ProcessGraph } from './model/types';

describe('useElkLayout', () => {
  it('lays a card left of the next one for RIGHT', async () => {
    const ref = (id: string) => ({ collection: 'physical_samples', id, code: id });
    const graph: ProcessGraph = {
      nodes: [
        { id: 'a', type: 'record', kind: 'sample', ref: ref('a'), ins: [], outs: ['a:out:0'] },
        { id: 'b', type: 'record', kind: 'sample', ref: ref('b'), ins: ['b:in:0'], outs: [] },
      ],
      wires: [{ id: 'w', from: 'a:out:0', to: 'b:in:0', carries: null, flow: 'sample', bundled: false, origin: 'a' }],
      hidden: [],
      truncated: false,
    };
    const size = { width: 100, height: 40 };
    const pos = await useElkLayout().layout(graph, new Set(['a', 'b']), { a: size, b: size }, 'RIGHT');
    expect(Object.keys(pos).sort()).toEqual(['a', 'b']);
    expect(pos.b.x).toBeGreaterThan(pos.a.x + 100);
  });
});
