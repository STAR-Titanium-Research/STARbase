import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, type ShallowRef } from 'vue';
import type { HostApi } from '@d1/ui';
import { mkData, mkOp, mkSample } from './model/fixtures';
import { loadFamily, loadRecordRef, loadRelationDefs, loadUsedIn } from './model/loadFamily';
import type { ProcessData } from './model/types';
import { useMapCanvas } from './useMapCanvas';
import { useProcessMap } from './useProcessMap';

// Vue Flow measures nodes in a browser; here a store that keeps what the canvas gives it: nodes with
// positions and a size, and the position changes it applies. ELK is a fixed table so the test says where
// "the layout" puts every card: one column, 100 px apart, in the order of the graph.
interface FakeNode {
  id: string;
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
  data: unknown;
  class?: string;
}
const store = vi.hoisted(() => ({ nodes: null as unknown, layouts: 0, gate: null as Promise<void> | null }));

vi.mock('@vue-flow/core', async (orig) => {
  const { shallowRef: sref, ref: vref } = await import('vue');
  const nodes = sref<FakeNode[]>([]);
  const edges = sref<{ id: string; class?: string }[]>([]);
  store.nodes = nodes;
  const vf = {
    vueFlowRef: vref({}),
    getNodes: nodes,
    getEdges: edges,
    viewport: vref({ zoom: 1 }),
    findNode: (id: string) => nodes.value.find((n) => n.id === id),
    setNodes: (list: { id: string; position: { x: number; y: number }; data: unknown }[]) => {
      nodes.value = list.map((n) => {
        const old = nodes.value.find((o) => o.id === n.id);
        // A node keeps its measured size until it is measured again (a collapsed container that opened is taller).
        return { ...n, dimensions: old?.dimensions ?? { width: 310, height: 40 } };
      });
    },
    setEdges: (list: { id: string }[]) => void (edges.value = list),
    applyNodeChanges: (changes: { id: string; type: string; position?: { x: number; y: number } }[]) => {
      for (const c of changes) {
        const n = nodes.value.find((x) => x.id === c.id);
        if (n && c.type === 'position' && c.position) n.position = { ...c.position };
      }
    },
    // A node that is not collapsed is as tall as its rows: the test's stand-in for measuring.
    updateNodeInternals: () => {
      for (const n of nodes.value) {
        const d = n.data as { type?: string; collapsed?: boolean } | undefined;
        n.dimensions = d?.type === 'container' && !d.collapsed ? { width: 310, height: 200 } : { width: 310, height: 40 };
      }
    },
    onNodesInitialized: () => undefined,
    fitView: async () => true,
    setCenter: async () => true,
  };
  return { ...(await orig<typeof import('@vue-flow/core')>()), useVueFlow: () => vf };
});

vi.mock('./useElkLayout', () => ({
  useElkLayout: () => ({
    layout: async (graph: { nodes: { id: string }[] }, shown: Set<string>) => {
      store.layouts++;
      if (store.gate) await store.gate;
      const out: Record<string, { x: number; y: number }> = {};
      graph.nodes.filter((n) => shown.has(n.id)).forEach((n, i) => (out[n.id] = { x: 0, y: i * 100 }));
      return out;
    },
  }),
}));

vi.mock('./model/loadFamily', async (orig) => ({
  ...(await orig<typeof import('./model/loadFamily')>()),
  loadFamily: vi.fn(),
  loadRelationDefs: vi.fn(async () => null),
  loadStepRow: vi.fn(),
  loadRecordRef: vi.fn(),
  loadUsedIn: vi.fn(),
}));

const api = {} as HostApi;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};
const nodesOf = () => (store.nodes as ShallowRef<FakeNode[]>).value;
const at = (id: string) => nodesOf().find((n) => n.id === id)!.position;

const toolOps = (n: number) => Array.from({ length: n }, (_, i) => mkOp({ id: `u${i}`, code: `OP-${i}`, methodName: 'Turning', date: `2026-09-${String(28 - i).padStart(2, '0')}T09:00:00Z`, sampleId: `x${i}`, outputSampleId: `y${i}` }));
const familyOfX = (i: number): ProcessData =>
  mkData({
    samples: [mkSample(`x${i}`), mkSample(`y${i}`)],
    operations: [mkOp({ id: `u${i}`, code: `OP-${i}`, methodName: 'Turning', date: `2026-09-${String(28 - i).padStart(2, '0')}T09:00:00Z`, sampleId: `x${i}`, outputSampleId: `y${i}` })],
  });

async function open() {
  vi.mocked(loadRecordRef).mockResolvedValue({ collection: 'tools', id: 't1', code: 'TL-1' });
  vi.mocked(loadUsedIn).mockResolvedValue({ items: toolOps(5), total: 5 });
  const route = reactive({ path: '/map', query: { focus: 'tools:t1' } as Record<string, unknown> });
  const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
  const canvas = useMapCanvas(map);
  await settle();
  return { map, canvas, route };
}

beforeEach(() => {
  store.layouts = 0;
  store.gate = null;
  (store.nodes as ShallowRef<FakeNode[]>).value = [];
  vi.mocked(loadFamily).mockReset();
  vi.mocked(loadRecordRef).mockReset();
  vi.mocked(loadUsedIn).mockReset();
  vi.mocked(loadRelationDefs).mockResolvedValue(null);
});

describe('useMapCanvas: an expand keeps what is placed (spec 6.7)', () => {
  it('lays a fresh focus out as a whole, in the layout\'s places', async () => {
    const { canvas } = await open();
    expect(canvas.laidOut.value).toBe(true);
    expect(nodesOf()).toHaveLength(6); // the tool and five collapsed operations
    expect(nodesOf().map((n) => n.position.y).sort((a, b) => a - b)).toEqual([0, 100, 200, 300, 400, 500]);
  });

  it('a card the person dragged stays where it was dropped when another card is expanded; new cards go beside the expanded one without overlapping', async () => {
    const { map } = await open();
    nodesOf().find((n) => n.id === 'op:u3')!.position = { x: 900, y: 900 }; // dragged
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    const layouts = store.layouts;

    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();

    expect(store.layouts).toBe(layouts + 1);
    expect(at('op:u3')).toEqual({ x: 900, y: 900 });
    // The opened container keeps its place; it is taller now, so what it would cover is pushed down the column, nothing else moves.
    expect(at('op:u0')).toEqual(before.get('op:u0'));
    for (const [id, was] of before) {
      expect(at(id).x, id).toBe(was.x);
      expect(at(id).y, id).toBeGreaterThanOrEqual(was.y);
    }
    // The cards of its family are new: they got places, and none lies on another card.
    expect(nodesOf().map((n) => n.id)).toEqual(expect.arrayContaining(['s:x0', 's:y0']));
    const boxes = nodesOf().map((n) => ({ id: n.id, ...n.position, width: n.dimensions.width, height: n.dimensions.height }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  });

  it('two expands that land before the layout ran are both placed, the dragged card still where it was', async () => {
    const { map } = await open();
    nodesOf().find((n) => n.id === 'op:u3')!.position = { x: 900, y: 900 };
    vi.mocked(loadFamily).mockImplementation(async (_api, id) => familyOfX(Number(String(id).slice(1))));
    await Promise.all([map.expand('op:u0'), map.expand('op:u1')]);
    await settle();
    expect(at('op:u3')).toEqual({ x: 900, y: 900 });
    const ids = nodesOf().map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['s:x0', 's:y0', 's:x1', 's:y1']));
    const boxes = nodesOf().map((n) => ({ id: n.id, ...n.position, width: n.dimensions.width, height: n.dimensions.height }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  });

  it('Re-layout puts everything back, the dragged card included', async () => {
    const { map, canvas } = await open();
    nodesOf().find((n) => n.id === 'op:u3')!.position = { x: 900, y: 900 };
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    expect(at('op:u3')).toEqual({ x: 900, y: 900 });
    await canvas.relayout();
    await settle();
    expect(at('op:u3').x).toBe(0);
    expect(at('op:u3').y).toBeLessThan(900);
  });

  it('a dragged card also stays when plus only reveals what is already loaded', async () => {
    const data = mkData({
      samples: ['a', 'b', 'c'].map((id) => mkSample(id)),
      operations: [
        mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'M' }),
        mkOp({ id: 'o2', sampleId: 'b', outputSampleId: 'c', date: '2026-09-02T09:00:00Z', methodName: 'M' }),
      ],
    });
    vi.mocked(loadFamily).mockResolvedValue(data);
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: '1' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async () => undefined });
    useMapCanvas(map);
    await settle();
    nodesOf().find((n) => n.id === 's:a')!.position = { x: 700, y: 700 };
    await map.expand('s:b');
    await settle();
    expect(nodesOf().some((n) => n.id === 's:c')).toBe(true);
    expect(at('s:a')).toEqual({ x: 700, y: 700 });
  });

  it('a new focus starts again: placed cards are forgotten and the layout runs over everything', async () => {
    const { route } = await open();
    nodesOf().find((n) => n.id === 'op:u3')!.position = { x: 900, y: 900 };
    vi.mocked(loadRecordRef).mockResolvedValue({ collection: 'tools', id: 't2', code: 'TL-2' });
    vi.mocked(loadUsedIn).mockResolvedValue({ items: toolOps(5), total: 5 });
    route.query = { focus: 'tools:t2' };
    await settle();
    expect(at('op:u3').x).toBe(0);
    expect(at('op:u3').y).toBeLessThan(900);
  });
});

describe('useMapCanvas: whenSettled (the export waits for the layout)', () => {
  it('is true at once when nothing is being laid out or moved', async () => {
    const { canvas } = await open();
    expect(await canvas.whenSettled()).toBe(true);
  });

  it('waits for a layout that is running, then says true as soon as it ends (no poll interval to wait out)', async () => {
    const { canvas, map } = await open();
    let release!: () => void;
    store.gate = new Promise<void>((r) => (release = r));
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    void map.expand('op:u0');
    await settle(); // the layout has started and is held by the gate
    vi.useFakeTimers(); // the clock stands still: only the layout ending can settle it
    try {
      let done: boolean | null = null;
      void canvas.whenSettled(2000).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBeNull(); // still laying out, well inside the time it was given
      release();
      await vi.advanceTimersByTimeAsync(0); // microtasks only: no time passes
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the time it was given, so the export can tell the person instead of photographing a moving map', async () => {
    const { canvas, map } = await open();
    store.gate = new Promise<void>(() => undefined); // a layout that never ends
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    void map.expand('op:u0');
    await settle();
    vi.useFakeTimers();
    try {
      let done: boolean | null = null;
      void canvas.whenSettled(60).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(59);
      expect(done).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
