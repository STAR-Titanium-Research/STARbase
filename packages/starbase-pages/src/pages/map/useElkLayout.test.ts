import { describe, expect, it, vi } from 'vitest';
import { useElkLayout } from './useElkLayout';
import type { ProcessGraph } from './model/types';
import { buildGraph } from './model/buildGraph';
import { fanData, fanPage } from './model/fans';
import { mkOp } from './model/fixtures';

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

describe('useElkLayout import failure', () => {
  it('does not cache a rejected import: the next layout tries again', async () => {
    vi.resetModules();
    let made = 0;
    vi.doMock('elkjs/lib/elk.bundled.js', () => ({
      default: class {
        constructor() {
          if (++made === 1) throw new Error('chunk failed');
        }
        layout = async () => ({ id: 'root', children: [] });
      },
    }));
    const { useElkLayout: fresh } = await import('./useElkLayout');
    const g: ProcessGraph = { nodes: [], wires: [], hidden: [], truncated: false };
    await expect(fresh().layout(g, new Set(), {}, 'RIGHT')).rejects.toThrow('chunk failed');
    await expect(fresh().layout(g, new Set(), {}, 'RIGHT')).resolves.toEqual({});
    vi.doUnmock('elkjs/lib/elk.bundled.js');
  });
});

describe('useElkLayout: a used-in fan of 20 collapsed containers', () => {
  it('is one column in the order of the list (newest first), the record before it and "+N more" at the end', async () => {
    const ops = Array.from({ length: 20 }, (_, i) => mkOp({ id: `u${i}`, date: `2026-09-${String(28 - i).padStart(2, '0')}T09:00:00Z` }));
    const data = fanData({ collection: 'tools', id: 't1', code: 'TL', kind: 'tool' }, fanPage('tools', { items: ops, total: 47 }, 1));
    const graph = buildGraph(data, [], { slots: () => [] });
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const n of graph.nodes) sizes[n.id] = n.type === 'container' ? { width: 310, height: 40 } : { width: 220, height: 80 };
    const pos = await useElkLayout().layout(graph, new Set(graph.nodes.map((n) => n.id)), sizes, 'RIGHT');

    const column = ['op:u0', 'op:u1', 'op:u2', 'op:u3', 'op:u19', 'more:tools:t1'];
    expect(new Set(column.map((id) => pos[id].x)).size).toBe(1);
    const ys = Array.from({ length: 20 }, (_, i) => pos[`op:u${i}`].y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys); // in list order
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(40); // none on another
    expect(pos['more:tools:t1'].y).toBeGreaterThan(ys[19]);
    expect(pos['f:tools:t1'].x).toBeLessThan(pos['op:u0'].x);
  });
});
