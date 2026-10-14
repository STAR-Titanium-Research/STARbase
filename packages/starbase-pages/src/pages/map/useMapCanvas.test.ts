import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, type ShallowRef } from 'vue';
import type { HostApi } from '@d1/ui';
import { mkData, mkOp, mkSample } from './model/fixtures';
import { loadFamily, loadRelationDefs } from './model/loadFamily';
import { loadRecordRef, loadUsedIn } from './model/loadFans';
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
const store = vi.hoisted(() => ({ nodes: null as unknown, layouts: 0, gate: null as Promise<void> | null, tall: new Map<string, number>(), dragStops: [] as ((e: { node: { id: string }; nodes: { id: string }[] }) => void)[] }));

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
        n.dimensions = { width: 310, height: store.tall.get(n.id) ?? (d?.type === 'container' && !d.collapsed ? 200 : 40) };
      }
    },
    onNodesInitialized: () => undefined,
    onNodeDragStop: (fn: (e: { node: { id: string }; nodes: { id: string }[] }) => void) => void store.dragStops.push(fn),
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
}));
vi.mock('./model/loadFans', async (orig) => ({
  ...(await orig<typeof import('./model/loadFans')>()),
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
/** The person drags a card to `to` and lets go: Vue Flow moves it, then reports the drag stop. */
const drag = (id: string, to: { x: number; y: number }) => {
  nodesOf().find((n) => n.id === id)!.position = { ...to };
  for (const fn of store.dragStops) fn({ node: { id }, nodes: [{ id }] });
};
const noOverlaps = (involving: string[]) => {
  const boxes = nodesOf().map((n) => ({ id: n.id, ...n.position, width: n.dimensions.width, height: n.dimensions.height }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!involving.includes(a.id) && !involving.includes(b.id)) continue; // (the fake's one-column layout is not collision-free for cards it laid out itself)
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
    }
  }
};

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
  store.dragStops.length = 0;
  store.tall.clear();
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

// A chain a - b - c - d - e (one operation between each pair) with a stock lot on a, focused on a.
const chain = () =>
  mkData({
    samples: ['a', 'b', 'c', 'd', 'e'].map((id) => mkSample(id)),
    stock: [{ lotId: 'l1', lotCode: 'LOT-1', supplier: null, massUsedGrams: null, sampleId: 'a' }],
    operations: [
      mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'M' }),
      mkOp({ id: 'o2', sampleId: 'b', outputSampleId: 'c', date: '2026-09-02T09:00:00Z', methodName: 'M' }),
      mkOp({ id: 'o3', sampleId: 'c', outputSampleId: 'd', date: '2026-09-03T09:00:00Z', methodName: 'M' }),
      mkOp({ id: 'o4', sampleId: 'd', outputSampleId: 'e', date: '2026-09-04T09:00:00Z', methodName: 'M' }),
    ],
  });
async function openChain(query: Record<string, unknown> = {}) {
  vi.mocked(loadFamily).mockResolvedValue(chain());
  const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: '1', ...query } as Record<string, unknown> });
  const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
  const canvas = useMapCanvas(map);
  await settle();
  return { map, canvas, route };
}

describe('useMapCanvas: a dragged card stays put when what is shown changes (spec D18)', () => {
  it('a dragged card keeps its position when a Show chip hides another kind', async () => {
    const { map } = await openChain();
    expect(nodesOf().some((n) => n.id === 'lot:l1')).toBe(true);
    drag('s:b', { x: 900, y: 900 });
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    const layouts = store.layouts;

    map.toggleKind('stock_lot');
    await settle();

    expect(store.layouts).toBe(layouts + 1);
    expect(nodesOf().some((n) => n.id === 'lot:l1')).toBe(false);
    expect(at('s:b')).toEqual({ x: 900, y: 900 });
    // Nothing else was laid out again either: the lot just disappears.
    for (const n of nodesOf()) expect(n.position, n.id).toEqual(before.get(n.id));
  });

  it('a card that comes back with its Show chip is placed beside its neighbour, not on a dragged card', async () => {
    const { map } = await openChain();
    map.toggleKind('stock_lot');
    await settle();
    const home = { ...at('s:a') };
    drag('s:a', { x: home.x, y: home.y + 500 });
    map.toggleKind('stock_lot');
    await settle();
    expect(nodesOf().some((n) => n.id === 'lot:l1')).toBe(true);
    expect(at('s:a')).toEqual({ x: home.x, y: home.y + 500 });
    noOverlaps(['lot:l1']);
  });

  it('a dragged card keeps its position when Reach changes; the cards a larger Reach adds do not land on it', async () => {
    const { map } = await openChain();
    expect(nodesOf().some((n) => n.id === 's:d')).toBe(false);
    drag('s:a', { x: 700, y: 700 });
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));

    map.setReach(3);
    await settle();

    expect(nodesOf().some((n) => n.id === 's:d')).toBe(true);
    expect(at('s:a')).toEqual({ x: 700, y: 700 });
    for (const [id, was] of before) expect(at(id), id).toEqual(was);
    noOverlaps(nodesOf().filter((n) => !before.has(n.id)).map((n) => n.id));
  });

  it('a smaller Reach just drops the cards that fall away; the rest stay where they were', async () => {
    const { map } = await openChain({ reach: '3' });
    drag('s:a', { x: 700, y: 700 });
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    map.setReach(1);
    await settle();
    expect(nodesOf().some((n) => n.id === 's:d')).toBe(false);
    for (const n of nodesOf()) expect(n.position, n.id).toEqual(before.get(n.id));
  });

  it('a dragged card keeps its position when "+N more from the form" opens: the card really grows and the others make room, none onto the dragged one', async () => {
    const { map, canvas } = await open();
    const u0 = { ...at('op:u0') };
    drag('op:u3', { x: u0.x, y: u0.y + 230 }); // just where a card pushed down by u0 would land (u0 is 200 tall, plus the gap)
    const layouts = store.layouts;
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    store.tall.set('op:u0', 200); // the form's rows open: the card is taller now
    map.toggleMore('op:u0');
    await canvas.remeasure('op:u0');
    await canvas.reflow();
    await settle();
    expect(store.layouts).toBe(layouts + 1);
    expect(at('op:u0')).toEqual(u0);
    expect(at('op:u3')).toEqual(before.get('op:u3'));
    // the card grew: cards it covers made room (so something moved), and none of them came to rest on the dragged card
    expect(nodesOf().some((n) => n.id !== 'op:u3' && at(n.id).y !== before.get(n.id)!.y)).toBe(true);
    noOverlaps(['op:u3']);
  });

  it('a card that is dragged is not pushed aside by a card that grew', async () => {
    const { map } = await open();
    drag('op:u1', { ...at('op:u1') }); // dropped where it was (under u0), so it is pinned there
    const was = { ...at('op:u1') };
    const u2 = { ...at('op:u2') };
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0'); // u0 grows to 200 px: it would cover the cards under it
    await settle();
    expect(at('op:u1')).toEqual(was);
    // a card that was not dragged is made room for
    expect(at('op:u2').y).toBeGreaterThan(u2.y);
  });

  it('Re-layout puts every card back, dragged ones too, after a Show or Reach change', async () => {
    const { map, canvas } = await openChain();
    drag('s:b', { x: 900, y: 900 });
    map.toggleKind('stock_lot');
    map.setReach(3);
    await settle();
    expect(at('s:b')).toEqual({ x: 900, y: 900 });
    await canvas.relayout();
    await settle();
    expect(at('s:b').x).toBe(0);
    expect(at('s:b').y).toBeLessThan(900);
  });

  it('a new direction lays everything out again, like Re-layout', async () => {
    const { map } = await openChain();
    drag('s:b', { x: 900, y: 900 });
    map.setDir('DOWN');
    await settle();
    expect(at('s:b').x).toBe(0);
    expect(at('s:b').y).toBeLessThan(900);
  });

  it('a new focus forgets the drags', async () => {
    const { route } = await openChain();
    drag('s:b', { x: 900, y: 900 });
    route.query = { focus: 'physical_samples:c', reach: '1' };
    await settle();
    expect(at('s:b').x).toBe(0);
    expect(at('s:b').y).toBeLessThan(900);
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
