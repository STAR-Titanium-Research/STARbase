import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref, type ShallowRef } from 'vue';
import type { HostApi } from '@d1/ui';
import { mkData, mkLineage, mkOp, mkSample } from './model/fixtures';
import { loadFamily, loadRelationDefs } from './model/loadFamily';
import { loadRecordRef, loadUsedIn } from './model/loadFans';
import { nodeOfSocket } from './model/sockets';
import type { ContainerNode as ContainerData, MapNode, ProcessData } from './model/types';
import { MIN_ZOOM, screenPixel, useMapCanvas, type CanvasEdit } from './useMapCanvas';
import { useProcessMap } from './useProcessMap';

// Vue Flow measures nodes in a browser; here a store that keeps what the canvas gives it: nodes with
// positions and a size, and the position changes it applies. ELK is a fixed table so the test says where
// "the layout" puts every card: one column, 100 px apart, in the order of the graph.
interface FakeGraph {
  nodes: { id: string; type?: string; rows?: { in?: string; out?: string }[] }[];
  wires: { from: string; to: string }[];
}
interface FakeNode {
  id: string;
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
  data: unknown;
  class?: string;
}
const store = vi.hoisted(() => ({ nodes: null as unknown, layouts: 0, gate: null as Promise<void> | null, elk: null as null | ((graph: FakeGraph, shown: Set<string>, dir: 'RIGHT' | 'DOWN') => Record<string, { x: number; y: number }>), tall: new Map<string, number>(), moves: [] as { id: string; from: { x: number; y: number }; position: { x: number; y: number } }[], selects: [] as { id: string; selected: boolean }[], internals: [] as (string[] | undefined)[], dragStops: [] as ((e: { node: { id: string }; nodes: { id: string }[] }) => void)[], dragStarts: [] as ((e: { node: { id: string }; nodes: { id: string }[] }) => void)[] }));

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
    applyNodeChanges: (changes: { id: string; type: string; selected?: boolean; from?: { x: number; y: number }; position?: { x: number; y: number } }[]) => {
      for (const c of changes) {
        if (c.type === 'select') store.selects.push({ id: c.id, selected: !!c.selected });
        if (c.type === 'position' && c.position && c.from) store.moves.push({ id: c.id, from: c.from, position: c.position });
        const n = nodes.value.find((x) => x.id === c.id);
        if (n && c.type === 'position' && c.position) n.position = { ...c.position };
      }
    },
    // A node that is not collapsed is as tall as its rows: the test's stand-in for measuring.
    updateNodeInternals: (ids?: string[]) => {
      store.internals.push(ids);
      for (const n of nodes.value) {
        const d = n.data as { type?: string; collapsed?: boolean } | undefined;
        n.dimensions = { width: 310, height: store.tall.get(n.id) ?? (d?.type === 'container' && !d.collapsed ? 200 : 40) };
      }
    },
    onNodesInitialized: () => undefined,
    onNodeDragStop: (fn: (e: { node: { id: string }; nodes: { id: string }[] }) => void) => void store.dragStops.push(fn),
    onNodeDragStart: (fn: (e: { node: { id: string }; nodes: { id: string }[] }) => void) => void store.dragStarts.push(fn),
    screenToFlowCoordinate: (p: { x: number; y: number }) => ({ x: p.x - 10, y: p.y - 20 }),
    fitView: async () => true,
    setCenter: async () => true,
  };
  return { ...(await orig<typeof import('@vue-flow/core')>()), useVueFlow: () => vf };
});

vi.mock('./useElkLayout', () => ({
  useElkLayout: () => ({
    layout: async (graph: FakeGraph, shown: Set<string>, _sizes: unknown, dir: 'RIGHT' | 'DOWN') => {
      store.layouts++;
      if (store.gate) await store.gate;
      if (store.elk) return store.elk(graph, shown, dir);
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
/** The drop of a card, as Vue Flow reports it: the node with its data and place. */
const dropOn = (id: string, position: { x: number; y: number }) => {
  for (const fn of store.dragStops) fn({ node: { id, data: { id }, position } as never, nodes: [{ id }] });
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
  store.dragStarts.length = 0;
  store.tall.clear();
  store.elk = null;
  store.moves.length = 0;
  store.selects.length = 0;
  store.internals.length = 0;
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

  // ELK stand-in whose cards do not touch (the default column is 100 apart: a container 200 tall would lie on the next one). It keeps its last answer.
  const columnElk = (step = 300) => {
    const last: Record<string, { x: number; y: number }> = {};
    const fn = (graph: FakeGraph, shown: Set<string>) => {
      for (const k of Object.keys(last)) delete last[k];
      graph.nodes.filter((n) => shown.has(n.id)).forEach((n, i) => (last[n.id] = { x: 0, y: i * step }));
      return { ...last };
    };
    return Object.assign(fn, { last });
  };
  const apartEverywhere = () => {
    const boxes = nodesOf().map((n) => ({ id: n.id, ...n.position, width: n.dimensions.width, height: n.dimensions.height }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  };

  it('＋ lays everything out again with ELK: a dragged card stays where it was dropped, and the card pressed keeps its place, the rest follow ELK moved by the same offset', async () => {
    const { map } = await open();
    const elk = columnElk();
    store.elk = elk;
    drag('op:u3', { x: 900, y: 900 }); // dragged; it is wired to the same tool as the card that is expanded, so lining up with it would shift everything
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    const layouts = store.layouts;

    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();

    expect(store.layouts).toBe(layouts + 1);
    expect(at('op:u3')).toEqual({ x: 900, y: 900 });
    expect(at('op:u0')).toEqual(before.get('op:u0'));
    const shift = { x: before.get('op:u0')!.x - elk.last['op:u0'].x, y: before.get('op:u0')!.y - elk.last['op:u0'].y };
    for (const n of nodesOf()) {
      if (n.id === 'op:u3') continue;
      expect(n.position, n.id).toEqual({ x: elk.last[n.id].x + shift.x, y: elk.last[n.id].y + shift.y });
    }
    // It really was laid out again (a card that was not dragged is not where it was), and the cards of the family are there, apart from each other.
    expect([...before].some(([id, was]) => id !== 'op:u3' && (at(id).x !== was.x || at(id).y !== was.y))).toBe(true);
    expect(nodesOf().map((n) => n.id)).toEqual(expect.arrayContaining(['s:x0', 's:y0']));
    apartEverywhere();
  });

  it('a card that ELK would put on a dragged card steps clear of it', async () => {
    const { map } = await open();
    const elk = columnElk();
    store.elk = elk;
    const u0 = { ...at('op:u0') };
    // The card is dropped where the card under u0 will be after the expand (u0 keeps its place, ELK's next place is 300 below it).
    drag('op:u3', { x: u0.x, y: u0.y + 300 });
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    expect(at('op:u3')).toEqual({ x: u0.x, y: u0.y + 300 });
    apartEverywhere();
  });

  it('− lays out again the same way: the card pressed keeps its place and a dragged card stays', async () => {
    const { map } = await open();
    const elk = columnElk();
    store.elk = elk;
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    drag('op:u3', { x: 900, y: 900 });
    const u0 = { ...at('op:u0') };
    map.collapse('op:u0');
    await settle();
    expect(nodesOf().some((n) => n.id === 's:x0')).toBe(false);
    expect(at('op:u3')).toEqual({ x: 900, y: 900 });
    expect(at('op:u0')).toEqual(u0);
    const shift = { x: u0.x - elk.last['op:u0'].x, y: u0.y - elk.last['op:u0'].y };
    for (const n of nodesOf()) if (n.id !== 'op:u3') expect(n.position, n.id).toEqual({ x: elk.last[n.id].x + shift.x, y: elk.last[n.id].y + shift.y });
  });

  it('a Show chip does not lay out again: the cards that were placed stay where they are (only ＋ and − do)', async () => {
    const { map } = await openChain();
    const before = new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
    map.toggleKind('stock_lot');
    await settle();
    for (const n of nodesOf()) expect(n.position, n.id).toEqual(before.get(n.id));
  });

  it('two expands that land before the layout ran are both placed, the dragged card still where it was', async () => {
    const { map } = await open();
    drag('op:u3', { x: 900, y: 900 });
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
    drag('op:u3', { x: 900, y: 900 });
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
    drag('s:a', { x: 700, y: 700 });
    await map.expand('s:b');
    await settle();
    expect(nodesOf().some((n) => n.id === 's:c')).toBe(true);
    expect(at('s:a')).toEqual({ x: 700, y: 700 });
  });

  it('a new focus starts again: placed cards are forgotten and the layout runs over everything', async () => {
    const { route } = await open();
    drag('op:u3', { x: 900, y: 900 });
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

// A recorded batch of five cuts from one sample, each cut piece going on to a step of its own: folded, the container has sockets
// out:0, out:1 and a bundle socket for the other three.
const batchOfCuts = () =>
  mkData({
    samples: ['p', ...[0, 1, 2, 3, 4].flatMap((i) => [`c${i}`, `e${i}`])].map((id) => mkSample(id)),
    operations: [
      ...[0, 1, 2, 3, 4].map((i) => mkOp({ id: `cut${i}`, sampleId: 'p', outputSampleId: `c${i}`, batchId: 'B1', date: '2026-09-01T09:00:00Z', methodName: 'Wire cut' })),
      ...[0, 1, 2, 3, 4].map((i) => mkOp({ id: `d${i}`, sampleId: `c${i}`, outputSampleId: `e${i}`, date: `2026-09-0${i + 2}T09:00:00Z`, methodName: `Step ${i}` })),
    ],
    batchCodes: { B1: 'B-1' },
  });
// A recorded batch that takes five samples in (an anneal): sockets in:0, in:1 and a bundle socket for the other three.
const batchOfInputs = () =>
  mkData({
    samples: [0, 1, 2, 3, 4].map((i) => mkSample(`a${i}`)),
    operations: [0, 1, 2, 3, 4].map((i) => mkOp({ id: `h${i}`, sampleId: `a${i}`, batchId: 'B2', date: '2026-09-01T09:00:00Z', methodName: 'Anneal' })),
    batchCodes: { B2: 'B-2' },
  });
/**
 * Stands in for ELK with the container's ports in FIXED_ORDER: the cards on one side of the batch are stacked along the cross axis in
 * the order of its sockets (what follows them stays in their lane). What shares the bundle socket has no order of its own, so here
 * it comes out reversed (as ELK may).
 */
const elkBySocketOrder = (batch: string, side: 'in' | 'out') => (graph: FakeGraph, shown: Set<string>, dir: 'RIGHT' | 'DOWN') => {
  const box = graph.nodes.find((n) => n.id === batch)!;
  const sockets = [...new Set((box.rows ?? []).map((r) => (side === 'out' ? r.out : r.in)!))].sort((a, b) => Number(a.endsWith(':b')) - Number(b.endsWith(':b')));
  const mine = (w: { from: string; to: string }) => (side === 'out' ? w.from : w.to);
  const fed = graph.wires
    .filter((w) => sockets.includes(mine(w)))
    .map((w) => ({ id: nodeOfSocket(side === 'out' ? w.to : w.from), socket: sockets.indexOf(mine(w)), bundle: mine(w).endsWith(':b') }))
    .sort((a, b) => a.socket - b.socket || (a.bundle ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
  const first = side === 'out' ? 2 : 0; // the layer the fed cards are on
  const at = (layer: number, lane: number) => (dir === 'RIGHT' ? { x: layer * 400, y: lane * 100 } : { x: lane * 400, y: layer * 400 });
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of graph.nodes) if (shown.has(n.id)) out[n.id] = at(n.id === batch ? 1 : 0, 0);
  fed.forEach((f, i) => {
    out[f.id] = at(first, i);
    if (side === 'out') {
      // what comes after a fed card stays in its lane
      let frontier = [f.id];
      for (let layer = first + 1; frontier.length && layer < 8; layer++) {
        frontier = graph.wires.filter((w) => frontier.includes(nodeOfSocket(w.from))).map((w) => nodeOfSocket(w.to));
        for (const id of frontier) out[id] = at(layer, i);
      }
    }
  });
  return out;
};

describe('useMapCanvas: unfolding or folding a container re-deals the places of the cards on its sockets', () => {
  type Dir = 'RIGHT' | 'DOWN';
  async function openBatch(opts: { dir?: Dir; side?: 'in' | 'out' } = {}) {
    const { dir = 'RIGHT', side = 'out' } = opts;
    const batch = side === 'out' ? 'batch:B1' : 'batch:B2';
    store.elk = elkBySocketOrder(batch, side);
    vi.mocked(loadFamily).mockResolvedValue(side === 'out' ? batchOfCuts() : batchOfInputs());
    const route = reactive({ path: '/map', query: { focus: side === 'out' ? 'physical_samples:p' : 'physical_samples:a0', reach: 'all' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    const canvas = useMapCanvas(map);
    if (dir === 'DOWN') map.setDir('DOWN');
    await settle();
    return { map, canvas, batch, side, dir };
  }
  type Opened = Awaited<ReturnType<typeof openBatch>>;
  const snapshot = () => new Map(nodesOf().map((n) => [n.id, { ...n.position }]));
  /** The cards on the container's sockets on one side, in the order of its rows. */
  const rowsOf = ({ map, batch, side }: Opened) => {
    const g = map.graph.value!;
    const box = g.nodes.find((n): n is ContainerData => n.id === batch)!;
    return box.rows.map((r) => {
      const socket = (side === 'out' ? r.out : r.in)!;
      const w = g.wires.find((x) => (side === 'out' ? x.from : x.to) === socket)!;
      return { socket, card: nodeOfSocket(side === 'out' ? w.to : w.from) };
    });
  };
  const alongCross = (id: string, dir: Dir) => (dir === 'RIGHT' ? at(id).y : at(id).x);
  /** For every pair of different sockets i < j: the card on i lies before the card on j (no wires cross). */
  const inSocketOrder = (o: Opened, skip: string[] = []) => {
    const rows = rowsOf(o);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[i].socket === rows[j].socket || skip.includes(rows[i].card) || skip.includes(rows[j].card)) continue;
        expect(alongCross(rows[i].card, o.dir), `${rows[i].card} (${rows[i].socket}) before ${rows[j].card} (${rows[j].socket})`).toBeLessThan(alongCross(rows[j].card, o.dir));
      }
    }
  };
  const stay = (before: Map<string, { x: number; y: number }>, ids: string[]) => {
    for (const id of ids) expect(at(id), id).toEqual(before.get(id));
  };
  const downstream = ['op:d0', 'op:d1', 'op:d2', 'op:d3', 'op:d4', 's:e0', 's:e1', 's:e2', 's:e3', 's:e4'];

  for (const dir of ['RIGHT', 'DOWN'] as const) {
    it(`unfolding puts the cards on its output sockets in the sockets' order, each in its own area (${dir})`, async () => {
      const o = await openBatch({ dir });
      const box = o.map.graph.value!.nodes.find((n): n is ContainerData => n.id === o.batch)!;
      expect(box.bundled).toBe(true);
      // folded: the three on the bundle socket came out in ELK's arbitrary (here reversed) order
      expect(alongCross('s:c3', dir)).toBeLessThan(alongCross('s:c2', dir));
      const before = snapshot();
      o.map.toggleRows(o.batch);
      await settle();
      expect(new Set(rowsOf(o).map((r) => r.socket)).size).toBe(5);
      inSocketOrder(o);
      // the cards only swap cross-axis slots: each keeps its own flow-axis place; what is not on a socket does not move
      for (const c of ['s:c0', 's:c1', 's:c2', 's:c3', 's:c4']) expect(dir === 'RIGHT' ? at(c).x : at(c).y, c).toBe(dir === 'RIGHT' ? before.get(c)!.x : before.get(c)!.y);
      stay(before, ['s:p', o.batch, ...downstream]);
    });
  }

  it('with a card downstream of the cuts dragged away, the others still follow the sockets and the dragged one (and what it feeds) does not move', async () => {
    const o = await openBatch();
    drag('op:d3', { x: 1700, y: 900 }); // the step after c3, far from where it was
    const before = snapshot();
    o.map.toggleRows(o.batch);
    await settle();
    inSocketOrder(o);
    stay(before, ['op:d3', 's:p', o.batch, ...downstream]);
  });

  it('a neighbour the person dragged stays where it was dropped; the others still follow the sockets', async () => {
    const o = await openBatch();
    drag('s:c3', { x: 900, y: 900 });
    const dropped = { ...at('s:c3') };
    o.map.toggleRows(o.batch);
    await settle();
    expect(at('s:c3')).toEqual(dropped);
    inSocketOrder(o, ['s:c3']);
  });

  it('folding it again deals the places once more, still without moving a dragged card', async () => {
    const o = await openBatch();
    o.map.toggleRows(o.batch);
    await settle();
    drag('s:c0', { x: 900, y: 900 });
    o.map.toggleRows(o.batch); // fold
    await settle();
    expect(at('s:c0')).toEqual({ x: 900, y: 900 });
    inSocketOrder(o, ['s:c0']);
  });

  it('the input side too: the samples that go in follow the container\'s input sockets', async () => {
    const o = await openBatch({ side: 'in' });
    const box = o.map.graph.value!.nodes.find((n): n is ContainerData => n.id === o.batch)!;
    expect(box.bundled).toBe(true);
    expect(alongCross('s:a3', 'RIGHT')).toBeLessThan(alongCross('s:a2', 'RIGHT'));
    const before = snapshot();
    o.map.toggleRows(o.batch);
    await settle();
    expect(new Set(rowsOf(o).map((r) => r.socket)).size).toBe(5);
    inSocketOrder(o);
    stay(before, [o.batch]);
  });

  it('the cards glide to their places: a move from where they were, not an instant placement like a new card\'s', async () => {
    const o = await openBatch();
    store.moves.length = 0;
    o.map.toggleRows(o.batch);
    await settle();
    const swapped = store.moves.filter((m) => m.id === 's:c3' || m.id === 's:c2');
    expect(swapped.length).toBeGreaterThan(0);
    for (const m of swapped) expect(m.from, m.id).not.toEqual(m.position);
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

describe('useMapCanvas: the card pressed keeps its place when its id changes (a material card that opens its fan)', () => {
  // The material card of a sample is `m:<sample>`; once its used-in fan is open the same record is the fan's root `f:materials:<id>`.
  const material = { collection: 'materials', id: 'mat1', code: 'MAT-1' };
  async function openMaterial() {
    const data = mkData({
      samples: ['a', 'b'].map((id, i) => mkSample(id, i === 0 ? { materialRef: material } : {})),
      operations: [mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
    });
    vi.mocked(loadFamily).mockResolvedValue(data);
    vi.mocked(loadUsedIn).mockResolvedValue({ items: ['a', 'z1', 'z2'].map((id) => mkSample(id)), total: 3 });
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: 'all' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    useMapCanvas(map);
    await settle();
    return map;
  }
  const columnWithGap = (graph: FakeGraph, shown: Set<string>) => Object.fromEntries(graph.nodes.filter((n) => shown.has(n.id)).map((n, i) => [n.id, { x: 0, y: i * 300 }]));

  it('＋ on the material card: its fan root takes its place, nothing jumps', async () => {
    const map = await openMaterial();
    expect(nodesOf().some((n) => n.id === 'm:a')).toBe(true);
    store.elk = columnWithGap;
    const was = { ...at('m:a') };
    await map.expand('m:a');
    await settle();
    expect(nodesOf().some((n) => n.id === 'm:a')).toBe(false);
    expect(nodesOf().some((n) => n.id === 'f:materials:mat1')).toBe(true);
    expect(at('f:materials:mat1')).toEqual(was);
  });

  it('a dragged material card stays dragged when it becomes the fan root', async () => {
    const map = await openMaterial();
    store.elk = columnWithGap;
    drag('m:a', { x: 900, y: 900 });
    await map.expand('m:a');
    await settle();
    expect(at('f:materials:mat1')).toEqual({ x: 900, y: 900 });
  });
});

describe('useMapCanvas: the sockets of a card are in the order of its wires (socketOrder)', () => {
  // A sample made from two parents (two lineage junctions into its two in-sockets). The parents' junctions are laid out by hand: the
  // parent p1 below the sample's row and p2 above it, which is the model's order reversed (p1's wire is wired to the first socket).
  const insOf = (id: string) => (nodesOf().find((n) => n.id === id)!.data as { ins: string[] }).ins;
  async function openParents(dir: 'RIGHT' | 'DOWN', swap = false) {
    const data = mkData({ samples: ['p1', 'p2', 'c'].map((id) => mkSample(id)), lineage: [mkLineage('p1', 'c', 'derived_from'), mkLineage('p2', 'c', 'derived_from')] });
    vi.mocked(loadFamily).mockResolvedValue(data);
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:c', reach: 'all' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    useMapCanvas(map);
    if (dir === 'DOWN') map.setDir('DOWN');
    const parentOf = (id: string) => (map.graph.value!.nodes.find((n) => n.id === id) as { parentId?: string } | undefined)?.parentId;
    store.elk = (graph) => {
      const out: Record<string, { x: number; y: number }> = {};
      for (const n of graph.nodes) {
        // the junction of p1 (and the card p1) is "below / right", the one of p2 "above / left"
        const lane = parentOf(n.id) === 'p1' || n.id === 's:p1' ? (swap ? 0 : 1) : parentOf(n.id) === 'p2' || n.id === 's:p2' ? (swap ? 1 : 0) : 0.5;
        const layer = n.id === 's:c' ? 2 : n.id.startsWith('s:p') ? 0 : 1;
        out[n.id] = dir === 'RIGHT' ? { x: layer * 400, y: lane * 400 } : { x: lane * 400, y: layer * 400 };
      }
      return out;
    };
    await settle();
    return map;
  }
  /** The parent behind each in-socket of the sample c, in the order the card draws them. */
  const parentsOnIns = (map: Awaited<ReturnType<typeof openParents>>) => {
    const wires = map.graph.value!.wires;
    return insOf('s:c').map((s) => {
      const from = wires.find((w) => w.to === s)!.from;
      const j = map.graph.value!.nodes.find((n) => n.id === nodeOfSocket(from)) as { parentId: string };
      return j.parentId;
    });
  };

  it('puts the wire that comes from above on the upper socket when the flow runs right (no crossing)', async () => {
    const map = await openParents('RIGHT');
    expect(parentsOnIns(map)).toEqual(['p2', 'p1']); // p2 is above
  });

  it('and the other way round when the parents swap places', async () => {
    const map = await openParents('RIGHT', true);
    expect(parentsOnIns(map)).toEqual(['p1', 'p2']);
  });

  it('puts the wire that comes from the left on the left socket when the flow runs down', async () => {
    const map = await openParents('DOWN');
    expect(parentsOnIns(map)).toEqual(['p2', 'p1']);
  });

  it('puts them in order again when a card is dragged to the other side', async () => {
    const map = await openParents('RIGHT');
    const p1 = nodesOf().find((n) => (n.data as { parentId?: string }).parentId === 'p1')!.id;
    drag(p1, { x: 400, y: -900 }); // now p1's junction is the upper one
    await settle();
    expect(parentsOnIns(map)).toEqual(['p1', 'p2']);
  });
});

describe('useMapCanvas: the cards glide to their places (useMapTween)', () => {
  let frames: ((now: number) => void)[] = [];
  let clock = 0;
  const run = (ms: number) => {
    clock += ms;
    const now = frames;
    frames = [];
    now.forEach((cb) => cb(clock));
  };
  const opacityOf = (id: string) => ((nodesOf().find((n) => n.id === id) as unknown as { style?: { opacity?: number } }).style ?? {}).opacity;
  const column = (graph: FakeGraph, shown: Set<string>) => Object.fromEntries(graph.nodes.filter((n) => shown.has(n.id)).map((n, i) => [n.id, { x: 0, y: i * 300 }]));
  beforeEach(() => {
    frames = [];
    clock = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('＋: new cards start at the card that was pressed, see-through, and end in their places in full; whenSettled waits for them', async () => {
    const { map, canvas } = await open();
    store.elk = column;
    const u0 = { ...at('op:u0') };
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    // at the start: the new cards are where the card was pressed, invisible; the layout is not settled
    expect(at('s:x0')).toEqual(u0);
    expect(opacityOf('s:x0')).toBe(0);
    expect(await canvas.whenSettled(20)).toBe(false);
    run(150);
    expect(opacityOf('s:x0')).toBeGreaterThan(0);
    expect(opacityOf('s:x0')).toBeLessThan(1);
    expect(at('s:x0').y).not.toBe(u0.y); // on its way (its place is above the card that was pressed)
    expect(opacityOf('op:u0')).toBeUndefined(); // a card that was there is not faded
    const settled = canvas.whenSettled(1000);
    run(200);
    expect(await settled).toBe(true);
    expect(opacityOf('s:x0')).toBeUndefined(); // 1: the style is cleared
    expect(at('op:u0')).toEqual(u0);
  });

  it('the first view of a family is placed at once (the canvas is hidden while it is laid out)', async () => {
    const { canvas } = await open();
    expect(canvas.laidOut.value).toBe(true);
    expect(frames).toHaveLength(0);
    expect(nodesOf().map((n) => n.position.y).sort((a, b) => a - b)).toEqual([0, 100, 200, 300, 400, 500]);
  });

  /** Where a layout of the ELK stand-in `column` puts every card after a ＋ on `pressed`, which keeps the place it had. */
  const afterPlus = (elk: Record<string, { x: number; y: number }>, pressed: string, was: { x: number; y: number }) =>
    Object.fromEntries(Object.entries(elk).map(([id, p]) => [id, { x: p.x + was.x - elk[pressed].x, y: p.y + was.y - elk[pressed].y }]));

  it('a second ＋ while the cards are still moving: the card pressed ends where the first layout was sending it (the map does not drift)', async () => {
    const { map } = await open();
    let last: Record<string, { x: number; y: number }> = {};
    store.elk = (graph, shown) => (last = column(graph, shown));
    vi.mocked(loadFamily).mockImplementation(async (_api, id) => familyOfX(Number(String(id).slice(1))));
    const u0 = { ...at('op:u0') };
    await map.expand('op:u0');
    await settle();
    const target1 = afterPlus(last, 'op:u0', u0);
    run(100); // mid-way: op:u1 is somewhere between where it was and target1
    expect(at('op:u1')).not.toEqual(target1['op:u1']);
    await map.expand('op:u1');
    await settle();
    run(100);
    run(400);
    expect(at('op:u1')).toEqual(target1['op:u1']);
    expect(at('op:u0').x).toBe(target1['op:u0'].x);
  });

  it('a layout that changes nothing but arrives mid-way (a reflow) does not freeze the cards that were moving', async () => {
    const { map, canvas } = await open();
    let last: Record<string, { x: number; y: number }> = {};
    store.elk = (graph, shown) => (last = column(graph, shown));
    const u0 = { ...at('op:u0') };
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    const target = afterPlus(last, 'op:u0', u0);
    run(100);
    await canvas.reflow();
    await settle();
    run(100);
    run(400);
    for (const n of nodesOf()) expect(n.position, n.id).toEqual(target[n.id]);
  });

  it('when the canvas goes away the move stops: nothing more is drawn, and nothing waits for it', async () => {
    vi.mocked(loadRecordRef).mockResolvedValue({ collection: 'tools', id: 't1', code: 'TL-1' });
    vi.mocked(loadUsedIn).mockResolvedValue({ items: toolOps(5), total: 5 });
    const route = reactive({ path: '/map', query: { focus: 'tools:t1' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    const scope = effectScope();
    const canvas = scope.run(() => useMapCanvas(map))!;
    await settle();
    store.elk = column;
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    run(100);
    expect(await canvas.whenSettled(20)).toBe(false);
    scope.stop();
    const drawn = store.moves.length;
    run(100);
    run(400);
    expect(store.moves).toHaveLength(drawn);
    expect(await canvas.whenSettled(20)).toBe(true);
  });

  it('grabbing a card mid-way takes it out of the move: it stays where it is, the others carry on', async () => {
    const { map } = await open();
    store.elk = column;
    vi.mocked(loadFamily).mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    const target3 = (() => {
      // where op:u3 ends: its place in the new column, moved like op:u0 (which keeps its place)
      const order = [...map.nodes.value.map((n) => n.id)];
      return at('op:u0').y + 300 * (order.indexOf('op:u3') - order.indexOf('op:u0'));
    })();
    run(100);
    const held = { ...at('op:u4') };
    for (const fn of store.dragStarts) fn({ node: { id: 'op:u4' }, nodes: [{ id: 'op:u4' }] });
    run(100);
    expect(at('op:u4')).toEqual(held);
    run(200);
    expect(at('op:u4')).toEqual(held);
    expect(at('op:u3').y).toBe(target3);
  });
});

describe('screenPixel: dashed outlines keep their on-screen width', () => {
  it('is one screen pixel in flow units at every zoom down to the minimum, and never more', () => {
    expect(screenPixel(1)).toBe(1);
    expect(screenPixel(0.5)).toBe(2);
    expect(screenPixel(0.1)).toBeCloseTo(10);
    expect(screenPixel(1.6)).toBeCloseTo(0.625);
    expect(screenPixel(0.01)).toBeCloseTo(1 / MIN_ZOOM); // below the minimum zoom counts as the minimum
    expect(screenPixel(Number.NaN)).toBeCloseTo(1 / MIN_ZOOM);
  });
});

describe('useMapCanvas: edit mode', () => {
  const editHooks = (over: Partial<CanvasEdit> = {}) => {
    const calls: string[] = [];
    const hooks: CanvasEdit = {
      positionOf: () => undefined,
      moved: (n, to) => void calls.push(`moved ${n.id} ${to.x},${to.y}`),
      relaid: (cards) => void calls.push(`relaid ${cards.length}`),
      ...over,
    };
    return { hooks, calls };
  };
  async function openEdit(hooks: CanvasEdit) {
    vi.mocked(loadRecordRef).mockResolvedValue({ collection: 'tools', id: 't1', code: 'TL-1' });
    vi.mocked(loadUsedIn).mockResolvedValue({ items: toolOps(5), total: 5 });
    const route = reactive({ path: '/map', query: { focus: 'tools:t1' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    const canvas = useMapCanvas(map, hooks);
    await settle();
    return { map, canvas };
  }

  it('keeps a card where the draft says it is, whatever the layout would do', async () => {
    const { hooks } = editHooks({ positionOf: (n: MapNode) => (n.id === 'op:u2' ? { x: 700, y: 650 } : undefined) });
    await openEdit(hooks);
    expect(at('op:u2')).toEqual({ x: 700, y: 650 });
    expect(at('op:u3')).not.toEqual({ x: 700, y: 650 });
  });

  it('tells the draft when a card is dropped', async () => {
    const { hooks, calls } = editHooks();
    await openEdit(hooks);
    dropOn('op:u1', { x: 12, y: 34 });
    expect(calls).toEqual(['moved op:u1 12,34']);
  });

  it('Re-layout puts every card where ELK says, and tells the draft the places (one change for all)', async () => {
    const { hooks, calls } = editHooks({ positionOf: (n: MapNode) => (n.id === 'op:u2' ? { x: 700, y: 650 } : undefined) });
    const { canvas } = await openEdit(hooks);
    expect(at('op:u2')).toEqual({ x: 700, y: 650 });
    await canvas.relayout();
    await settle();
    expect(at('op:u2')).not.toEqual({ x: 700, y: 650 });
    expect(calls.filter((c) => c.startsWith('relaid'))).toEqual([`relaid ${nodesOf().length}`]);
  });

  it('turns a point of the window into the map\'s own coordinates', async () => {
    const { canvas } = await openEdit(editHooks().hooks);
    expect(canvas.toFlow(110, 120)).toEqual({ x: 100, y: 100 });
  });

  it('is as before without edit mode: no hook is called', async () => {
    await open();
    dropOn('op:u1', { x: 1, y: 2 });
    expect(at('op:u1')).toBeDefined();
  });
});

describe('useMapCanvas: the selected card is the page\'s, never Vue Flow\'s', () => {
  // Vue Flow drags EVERY card it holds as selected along with the one the pointer grabs, so a card marked selected there moves whenever any
  // other card is dragged (found in a real browser: the recorded focus card flew across the map with a new card the person dragged).
  it('selecting a card tells Vue Flow of no selected card', async () => {
    const { map } = await open();
    map.select('op:u1');
    await settle();
    expect(map.selectedId.value).toBe('op:u1');
    expect(store.selects.filter((c) => c.selected)).toEqual([]);
  });
});

describe('useMapCanvas: a selection moves sockets, so Vue Flow measures them again (R5)', () => {
  // In edit mode the selected card draws its free socket and the others on that side move along the edge; Vue Flow only knows where a socket is
  // when it is told, so a wire kept its old end (found in a real browser: the wires of a selected operation hung 8 px off its sockets).
  const hooks: CanvasEdit = { active: () => true, positionOf: () => undefined, moved: () => undefined, relaid: () => undefined };
  const measured = () => store.internals.flatMap((ids) => ids ?? ['(all)']);
  it('selecting a card, and the card it leaves, are measured again; the others are not', async () => {
    vi.mocked(loadRecordRef).mockResolvedValue({ collection: 'tools', id: 't1', code: 'TL-1' });
    vi.mocked(loadUsedIn).mockResolvedValue({ items: toolOps(5), total: 5 });
    const route = reactive({ path: '/map', query: { focus: 'tools:t1' } as Record<string, unknown> });
    const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) });
    useMapCanvas(map, hooks);
    await settle();
    store.internals.length = 0;
    map.select('op:u1');
    await settle();
    expect(measured()).toContain('op:u1');
    store.internals.length = 0;
    map.select('op:u2');
    await settle();
    expect(measured()).toEqual(expect.arrayContaining(['op:u1', 'op:u2']));
    expect(measured()).not.toContain('op:u3');
  });

  it('is not needed outside edit mode: no socket moves when a card is selected', async () => {
    const { map } = await open();
    store.internals.length = 0;
    map.select('op:u1');
    await settle();
    expect(measured()).toEqual([]);
  });
});

describe('useMapCanvas: edit mode does not lay out again for what a card says', () => {
  const code = ref('OP-1');
  const overlay = {
    active: () => true,
    blank: () => false,
    keep: () => false,
    merge: (d: ProcessData | null) => ({ ...d!, operations: d!.operations.map((o) => ({ ...o, code: code.value })) }),
  };
  let scope = effectScope();
  afterEach(() => scope.stop());
  async function openOverlay() {
    scope = effectScope();
    code.value = 'OP-1';
    const data = mkData({
      samples: ['a', 'b'].map((id) => mkSample(id)),
      operations: [mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
    });
    vi.mocked(loadFamily).mockResolvedValue(data);
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: 'all' } as Record<string, unknown> });
    const { map, canvas } = scope.run(() => {
      const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) }, overlay);
      return { map, canvas: useMapCanvas(map, { active: () => true, positionOf: () => undefined, moved: () => undefined, relaid: () => undefined }) };
    })!;
    await settle();
    return { map, canvas };
  }
  const container = () => nodesOf().find((n) => (n.data as { type?: string }).type === 'container')!;

  it('patches the card in place: the same nodes, the new words, no layout', async () => {
    await openOverlay();
    const before = container();
    const layouts = store.layouts;
    code.value = 'OP-1x';
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    expect(container()).toBe(before);
    expect((container().data as ContainerData).code).toBe('OP-1x');
    expect(store.layouts).toBe(layouts);
  });

  it('lays out again, once, when the card changed size, after the typing pauses', async () => {
    await openOverlay();
    const layouts = store.layouts;
    store.tall.set(container().id, 320);
    for (let i = 0; i < 5; i++) {
      code.value = `OP-${i}`;
      await settle();
    }
    expect(store.layouts).toBe(layouts); // typing: nothing yet
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(store.layouts).toBe(layouts + 1);
  });
});

describe('useMapCanvas: edit mode places new cards clear of the others (R6)', () => {
  const extra = ref(false);
  // Reactive, like the draft's places: the canvas watches them.
  const stored = reactive(new Map<string, { x: number; y: number }>());
  const calls: string[] = [];
  let ownedIds: string[] = [];
  const overlay = {
    active: () => true,
    blank: () => false,
    keep: (n: MapNode) => n.id === 's:new1',
    merge: (d: ProcessData | null) => (extra.value ? { ...d!, samples: [...d!.samples, mkSample('new1', { draft: true })] } : d!),
  };
  const hooks: CanvasEdit = {
    active: () => true,
    positionOf: (n: MapNode) => stored.get(n.id),
    moved: () => undefined,
    relaid: (cards) => {
      for (const c of cards) stored.set(c.node.id, c.at);
      calls.push(`relaid ${cards.map((c) => c.node.id).join(',')}`);
    },
    owned: (n: MapNode) => ownedIds.includes(n.id),
    // (As the page does: the draft keeps the places it is told of.)
    settled: (cards) => {
      for (const c of cards) stored.set(c.node.id, c.at);
      calls.push(`settled ${cards.map((c) => `${c.node.id}@${c.at.x},${c.at.y}`).join(',')}`);
    },
  };
  let scope = effectScope();
  afterEach(() => scope.stop());
  async function openIt(withExtra = false) {
    scope = effectScope();
    extra.value = withExtra;
    stored.clear();
    calls.length = 0;
    ownedIds = [];
    const data = mkData({
      samples: ['a', 'b'].map((id) => mkSample(id)),
      operations: [mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
    });
    vi.mocked(loadFamily).mockResolvedValue(data);
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: 'all' } as Record<string, unknown> });
    const out = scope.run(() => {
      const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) }, overlay);
      return { map, canvas: useMapCanvas(map, hooks) };
    })!;
    await settle();
    return out;
  }
  const box = (id: string) => {
    const n = nodesOf().find((x) => x.id === id)!;
    return { x: n.position.x, y: n.position.y, width: n.dimensions.width, height: n.dimensions.height };
  };
  const apart = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

  it('a new card dropped on top of another steps to a free slot, and the draft keeps the new place', async () => {
    await openIt();
    const onA = { ...at('s:a') };
    stored.set('s:new1', onA); // dropped where the person clicked: on a card
    extra.value = true;
    await settle();
    expect(nodesOf().some((n) => n.id === 's:new1')).toBe(true);
    expect(apart(box('s:new1'), box('s:a'))).toBe(true);
    expect(at('s:a')).toEqual(onA);
    const moved = at('s:new1');
    expect(calls).toEqual([`settled s:new1@${moved.x},${moved.y}`]);
  });

  it('a new card that lies clear is left where it was put, and nothing is told to the draft', async () => {
    await openIt();
    stored.set('s:new1', { x: 5000, y: 5000 });
    extra.value = true;
    await settle();
    expect(at('s:new1')).toEqual({ x: 5000, y: 5000 });
    expect(calls).toEqual([]);
  });

  it('a new card with no place of its own is put clear of every card, beside what it was attached to', async () => {
    await openIt();
    extra.value = true;
    await settle();
    for (const id of ['s:a', 's:b']) expect(apart(box('s:new1'), box(id)), id).toBe(true);
    expect(calls).toEqual([]); // nothing was a stored place: nothing to keep
  });

  it('cards the person placed are where the draft says, even on each other, when a draft is opened (never re-flowed)', async () => {
    stored.set('s:a', { x: 40, y: 40 });
    stored.set('s:b', { x: 50, y: 50 });
    scope = effectScope();
    calls.length = 0;
    extra.value = false;
    ownedIds = [];
    vi.mocked(loadFamily).mockResolvedValue(
      mkData({ samples: ['a', 'b'].map((id) => mkSample(id)), operations: [mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })] }),
    );
    const route = reactive({ path: '/map', query: { focus: 'physical_samples:a', reach: 'all' } as Record<string, unknown> });
    scope.run(() => {
      const map = useProcessMap(api, route, { replace: async (to) => void (route.query = to.query) }, overlay);
      useMapCanvas(map, hooks);
    });
    await settle();
    expect(at('s:a')).toEqual({ x: 40, y: 40 });
    expect(at('s:b')).toEqual({ x: 50, y: 50 });
    expect(calls).toEqual([]);
  });

  it('Tidy moves only the draft\'s own cards, tells the draft once, and leaves every other card where it is', async () => {
    const { canvas } = await openIt(true);
    ownedIds = ['s:new1'];
    stored.set('s:new1', at('s:a')); // lying on a card, as a person can leave it
    const before = Object.fromEntries(nodesOf().filter((n) => n.id !== 's:new1').map((n) => [n.id, { ...n.position }]));
    await canvas.tidy();
    await settle();
    for (const [id, p] of Object.entries(before)) expect(at(id), id).toEqual(p);
    expect(calls.filter((c) => c.startsWith('relaid'))).toEqual(['relaid s:new1']);
    for (const id of Object.keys(before)) expect(apart(box('s:new1'), box(id)), id).toBe(true);
  });

  it('Tidy keeps where the draft\'s cards were when the draft had no place for them, in the step before, so Undo can take them back', async () => {
    const { canvas } = await openIt(true);
    ownedIds = ['s:new1'];
    const was = { ...at('s:new1') };
    await canvas.tidy();
    await settle();
    expect(calls[0]).toBe(`settled s:new1@${was.x},${was.y}`);
    expect(calls.filter((c) => c.startsWith('relaid'))).toEqual(['relaid s:new1']);
  });

  it('a place the draft changes by itself (Undo, Redo of a drag or of Tidy) is followed: the card goes there', async () => {
    await openIt(true);
    stored.set('s:new1', { x: 900, y: 900 });
    await settle();
    expect(at('s:new1')).toEqual({ x: 900, y: 900 });
    stored.set('s:new1', { x: 1300, y: 40 }); // Undo or Redo brings another place back
    await settle();
    expect(at('s:new1')).toEqual({ x: 1300, y: 40 });
    expect(calls).toEqual([]); // following the draft writes nothing to it
  });

  it('a card that comes back (Undo) goes to the place the draft has for it, even on another card, and writes nothing', async () => {
    await openIt(true);
    const onA = { ...at('s:a') };
    stored.set('s:new1', { x: 5000, y: 5000 });
    await settle();
    extra.value = false; // the card is removed
    await settle();
    expect(nodesOf().some((n) => n.id === 's:new1')).toBe(false);
    stored.set('s:new1', onA); // Undo brings it back: the draft has it where the person had dragged it, lying on a card
    extra.value = true;
    await settle();
    expect(at('s:new1')).toEqual(onA);
    expect(calls).toEqual([]);
  });

  it('canTidy is on only while the canvas holds something of the draft\'s own', async () => {
    const withDraft = await openIt(true);
    ownedIds = ['s:new1'];
    expect(withDraft.canvas.canTidy.value).toBe(true);
    const without = await openIt();
    ownedIds = [];
    expect(without.canvas.canTidy.value).toBe(false);
  });

  it('Tidy with nothing of the draft\'s on the canvas does nothing at all', async () => {
    const { canvas } = await openIt();
    const layouts = store.layouts;
    store.moves.length = 0;
    await canvas.tidy();
    await settle();
    expect(calls).toEqual([]);
    expect(store.moves).toEqual([]);
    expect(store.layouts).toBe(layouts + 1); // ELK was asked, and had nothing of the draft's to place
  });
});
