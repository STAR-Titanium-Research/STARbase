import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import type { HostApi } from '@d1/ui';
import { groupsOf, mkData, mkLineage, mkOp, mkSample } from './model/fixtures';
import type { ContainerNode, ProcessData } from './model/types';
import { loadFamily, loadRelationDefs } from './model/loadFamily';
import { HOVER_DELAY_MS, useProcessMap } from './useProcessMap';

vi.mock('./model/loadFamily', async (orig) => ({
  ...(await orig<typeof import('./model/loadFamily')>()),
  loadFamily: vi.fn(),
  loadRelationDefs: vi.fn(async () => null),
}));

const family = vi.mocked(loadFamily);
const api = {} as HostApi;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

/** The page's route and router, faked: replace() records the call and applies it like a router would. */
function setup(query: Record<string, unknown> = {}) {
  const route = reactive({ path: '/map', query: { ...query } as Record<string, unknown> });
  const replace = vi.fn(async (to: { path: string; query: Record<string, unknown> }) => {
    route.query = to.query;
  });
  const map = useProcessMap(api, route, { replace });
  return { map, route, replace };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

/** p is cut into 20 pieces, each piece into 20 more: 421 samples. */
function wide(): ProcessData {
  const ids = ['p'];
  const operations = [];
  for (let i = 0; i < 20; i++) {
    ids.push(`c${i}`);
    operations.push(mkOp({ id: `a${i}`, sampleId: 'p', outputSampleId: `c${i}`, date: '2026-09-01T09:00:00Z', methodName: 'Cut' }));
    for (let j = 0; j < 20; j++) {
      ids.push(`g${i}_${j}`);
      operations.push(mkOp({ id: `b${i}_${j}`, sampleId: `c${i}`, outputSampleId: `g${i}_${j}`, date: '2026-09-02T09:00:00Z', methodName: 'Cut' }));
    }
  }
  return mkData({ samples: ids.map((id) => mkSample(id)), operations });
}

const small = (): ProcessData =>
  mkData({
    samples: [mkSample('s1'), mkSample('s2')],
    operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
    lineage: [mkLineage('s1', 's2')],
  });

beforeEach(() => {
  family.mockReset();
  vi.mocked(loadRelationDefs).mockResolvedValue(null);
  vi.unstubAllGlobals();
});

describe('useProcessMap', () => {
  it('without a focus the status is empty and nothing is loaded', async () => {
    const { map } = setup();
    await settle();
    expect(map.status.value).toBe('empty');
    expect(family).not.toHaveBeenCalled();
  });

  it('reads the legacy ?sample=<id> as physical_samples:<id>', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ sample: 's1' });
    await settle();
    expect(family).toHaveBeenCalledWith(api, 's1');
    expect(map.status.value).toBe('ready');
    expect(map.focus.value).toEqual({ collection: 'physical_samples', id: 's1' });
    expect(map.focusNodeId.value).toBe('s:s1');
  });

  it('loads on ?focus= and shows the family at the default reach of 2', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    expect(map.status.value).toBe('loading');
    await settle();
    expect(map.status.value).toBe('ready');
    expect(map.reach.value).toBe(2);
    expect(map.graph.value?.nodes.length).toBeGreaterThan(2);
    expect(map.shown.value.has('s:s1')).toBe(true);
    expect(map.shown.value.has('s:s2')).toBe(true);
    expect(map.selectedId.value).toBe('s:s1');
  });

  it('d1-trace 404 (missing and unreadable look the same) is notVisible', async () => {
    family.mockRejectedValue(httpError(404));
    const { map } = setup({ focus: 'physical_samples:nope' });
    await settle();
    expect(map.status.value).toBe('notVisible');
  });

  it('any other failure is an error with the server text', async () => {
    family.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }));
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.status.value).toBe('error');
    expect(map.error.value).toContain('boom');
  });

  it('a focus that is not a sample is an error that says so, not a crash', async () => {
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    expect(map.status.value).toBe('error');
    expect(map.error.value).toMatch(/sample/i);
    expect(family).not.toHaveBeenCalled();
  });

  it('a newer focus wins over a slower older one', async () => {
    let release!: (d: ProcessData) => void;
    family.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { map, route } = setup({ focus: 'physical_samples:slow' });
    family.mockResolvedValueOnce(small());
    route.query = { focus: 'physical_samples:s1' };
    await settle();
    release(mkData({ samples: [mkSample('slow')] }));
    await settle();
    expect(map.data.value?.focus.id).toBe('s1');
  });

  it('reach: read from the URL, written back with router.replace on the same path, other keys kept', async () => {
    family.mockResolvedValue(small());
    const { map, replace } = setup({ focus: 'physical_samples:s1', reach: '3', keep: 'me' });
    await settle();
    expect(map.reach.value).toBe(3);
    map.setReach('all');
    expect(map.reach.value).toBe('all');
    expect(replace).toHaveBeenLastCalledWith({ path: '/map', query: { focus: 'physical_samples:s1', reach: 'all', keep: 'me' } });
  });

  it('writes focus (not the legacy sample) when the URL used ?sample=', async () => {
    family.mockResolvedValue(small());
    const { map, replace } = setup({ sample: 's1' });
    await settle();
    map.setReach(1);
    expect(replace).toHaveBeenLastCalledWith({ path: '/map', query: { focus: 'physical_samples:s1', reach: '1' } });
  });

  it('clearFocus drops focus and the legacy sample, keeping other keys, on the same path', async () => {
    family.mockResolvedValue(small());
    const { map, replace } = setup({ sample: 's1', reach: '3', keep: 'me' });
    await settle();
    map.clearFocus();
    expect(replace).toHaveBeenLastCalledWith({ path: '/map', query: { reach: '3', keep: 'me' } });
    await settle();
    expect(map.status.value).toBe('empty');
  });

  it('the focus sample names its project from a row that carries it; other projects are tagged on their cards', async () => {
    const proj = { collection: 'projects', id: 'p1', code: 'PRJ-1', label: 'Titanium study' };
    const data = mkData({
      samples: [mkSample('s1', { projectId: 'p1' }), mkSample('s2', { projectId: 'p2' }), mkSample('s3', { projectId: 'p1' })],
      operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', relations: { project_id: proj }, projectId: 'p1' })],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.project.value).toEqual(proj);
    const meta = (id: string) => (map.nodes.value.find((n) => n.id === id) as { meta?: string }).meta ?? '';
    expect(meta('s:s2')).toContain('other project');
    expect(meta('s:s1')).not.toContain('other project');
  });

  it('a reach change does not reload the family', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    map.setReach(1);
    await settle();
    expect(family).toHaveBeenCalledTimes(1);
  });

  it('an unknown reach in the URL falls back to 2', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1', reach: 'banana' });
    await settle();
    expect(map.reach.value).toBe(2);
  });

  it('shows part of a history that has more than 300 cards: reach is clamped and the banner is set', async () => {
    family.mockResolvedValue(wide());
    const { map } = setup({ focus: 'physical_samples:p', reach: 'all' });
    await settle();
    expect(map.reach.value).toBe('all');
    expect(map.effectiveReach.value).toBe(1);
    expect(map.partial.value).toBe(true);
    expect(map.shown.value.size).toBeLessThanOrEqual(300);
  });

  it('sets the banner when d1-trace cut a list, even though everything fits', async () => {
    family.mockResolvedValue({ ...small(), truncated: true });
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.partial.value).toBe(true);
    expect(map.effectiveReach.value).toBe(2);
  });

  it('no banner for a small whole family', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.partial.value).toBe(false);
  });

  it('probable batches group rows only while the chip is on', async () => {
    const data = mkData({
      samples: [mkSample('p'), mkSample('a'), mkSample('b')],
      operations: [
        mkOp({ id: 'x1', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', methodName: 'Cut', methodId: 'm' }),
        mkOp({ id: 'x2', sampleId: 'p', outputSampleId: 'b', date: '2026-09-01T10:00:00Z', methodName: 'Cut', methodId: 'm' }),
      ],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:p' });
    await settle();
    const containers = () => map.graph.value!.nodes.filter((n) => n.type === 'container');
    expect(map.probable.value).toBe(true);
    expect(containers()).toHaveLength(groupsOf(data, true).length);
    map.setProbable(false);
    expect(containers()).toHaveLength(2);
  });

  it('Show chips: hiding a kind drops its cards, and the choice is remembered under d1.map.show.v1', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const data = mkData({
      samples: [mkSample('s1')],
      stock: [{ lotId: 'l1', lotCode: 'LOT-1', supplier: null, massUsedGrams: null, sampleId: 's1' }],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.shown.value.has('lot:l1')).toBe(true);
    expect(map.presentKinds.value).toContain('stock_lot');
    map.toggleKind('stock_lot');
    expect(map.shown.value.has('lot:l1')).toBe(false);
    expect(map.hiddenKinds.value.has('stock_lot')).toBe(true);
    expect(JSON.parse(store.get('d1.map.show.v1')!)).toMatchObject({ hidden: ['stock_lot'] });

    // a new page reads it back
    const again = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(again.map.hiddenKinds.value.has('stock_lot')).toBe(true);
  });

  it('hidden kinds read back from storage are validated: only hideable kinds survive', async () => {
    const stored = JSON.stringify({ hidden: ['sample', 'operation', 'test', 'junction', 'nonsense', 7, 'stock_lot', 'equipment', 'settings'], probable: true });
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: () => undefined });
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect([...map.hiddenKinds.value].sort()).toEqual(['equipment', 'settings', 'stock_lot']);
    expect(map.shown.value.has('s:s1')).toBe(true);
    map.toggleKind('sample');
    expect(map.hiddenKinds.value.has('sample')).toBe(false);
  });

  it('setFocus loads a picked record: replace on the same path with focus and the current reach', async () => {
    family.mockResolvedValue(small());
    const { map, replace } = setup({ focus: 'physical_samples:s1', reach: '3', keep: 'me' });
    await settle();
    map.setFocus('physical_samples', 's2');
    expect(replace).toHaveBeenLastCalledWith({ path: '/map', query: { focus: 'physical_samples:s2', reach: '3', keep: 'me' } });
    await settle();
    expect(family).toHaveBeenLastCalledWith(api, 's2');
  });

  it('setFocus from the empty page, and on a collection the map cannot focus yet, shows its current state', async () => {
    const { map } = setup();
    await settle();
    map.setFocus('tools', 't1');
    await settle();
    expect(map.status.value).toBe('error');
    expect(map.error.value).toMatch(/sample/i);
  });

  it('localStorage that throws (or is missing) does not break toggleKind, setProbable or reading', async () => {
    const boom = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(() => map.toggleKind('equipment')).not.toThrow();
    expect(map.hiddenKinds.value.has('equipment')).toBe(true);
    expect(() => map.setProbable(false)).not.toThrow();
    expect(map.probable.value).toBe(false);

    vi.unstubAllGlobals(); // no localStorage at all (node)
    const bare = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(() => bare.map.toggleKind('equipment')).not.toThrow();
  });

  it('expand reveals what is one process step beyond a shown card', async () => {
    const data = mkData({
      samples: ['a', 'b', 'c', 'd'].map((id) => mkSample(id)),
      operations: [
        mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'M' }),
        mkOp({ id: 'o2', sampleId: 'b', outputSampleId: 'c', date: '2026-09-02T09:00:00Z', methodName: 'M' }),
        mkOp({ id: 'o3', sampleId: 'c', outputSampleId: 'd', date: '2026-09-03T09:00:00Z', methodName: 'M' }),
      ],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:a', reach: '1' });
    await settle();
    expect(map.shown.value.has('s:b')).toBe(true);
    expect(map.shown.value.has('s:c')).toBe(false);
    map.expand('s:b');
    expect(map.shown.value.has('s:c')).toBe(true);
    expect(map.shown.value.has('s:d')).toBe(false);
  });

  it('select sets selectedId and resolves its record; centre is asked for only with centre: true', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.selected.value?.ref).toMatchObject({ collection: 'physical_samples', id: 's1' });
    map.select('s:s2');
    expect(map.selectedId.value).toBe('s:s2');
    expect(map.selected.value?.ref.id).toBe('s2');
    const before = map.centreRequest.value;
    map.select('s:s1');
    expect(map.centreRequest.value).toBe(before);
    map.select('s:s1', { centre: true });
    expect(map.centreRequest.value).toMatchObject({ id: 's:s1' });
  });

  it('a container selects as its operation', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    const c = map.graph.value!.nodes.find((n) => n.type === 'container')!;
    map.select(c.id);
    expect(map.selected.value?.ref).toMatchObject({ collection: 'manufacturing_operations', id: 'o1' });
    expect(map.selectedRefKey.value).toBe('manufacturing_operations:o1');
  });

  it('hover falls back to the card when the pointer leaves a slot, and tooltip reads a wire hit path', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    map.hover('s:s1');
    map.hover('equipment:e1');
    expect(map.hovered.value?.id).toBe('equipment:e1');
    map.hover(null);
    expect(map.hovered.value?.id).toBe('s:s1');
    map.hover(null);
    expect(map.hovered.value).toBeNull();

    const wire = map.graph.value!.wires[0];
    map.hover(wire.id, { dataset: { tip: 'S2 · Sample\nfrom OP\ninto S-2' } } as unknown as HTMLElement);
    expect(map.tooltip.value).toEqual({ id: wire.id, lines: ['S2 · Sample', 'from OP', 'into S-2'], el: expect.anything(), wire: true });
    map.hover(null);
    expect(map.tooltip.value).toBeNull();
  });

  it('hovering a socket lists the wires on it', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    const wire = map.graph.value!.wires.find((w) => w.carries === 's2' || w.from.startsWith('s:s1'))!;
    map.hover(wire.from, {} as HTMLElement);
    expect(map.tooltip.value).toMatchObject({ id: wire.from, wire: false });
    expect(map.tooltip.value!.lines.length).toBeGreaterThan(0);
    expect(map.tooltip.value!.lines[0]).toMatch(/ · /);
    // The rail's Connections highlight what the socket's wires touch, only while it is hovered.
    expect(map.socketHighlight.value.has('s:s1')).toBe(true);
    map.hover(null);
    expect(map.tooltip.value).toBeNull();
    expect(map.socketHighlight.value.size).toBe(0);
    map.hover('s:s1', {} as HTMLElement); // a card is not a socket
    expect(map.socketHighlight.value.size).toBe(0);
  });

  it('the rail reads the selected record: info, connections, whether it is a card', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    expect(map.selectedInfo.value).toMatchObject({ kind: 'sample', code: 'S1' });
    expect(map.connections.value['Went on to']).toHaveLength(1);
    expect(map.connections.value['Went on to']![0]).toMatchObject({ collection: 'manufacturing_operations', id: 'o1', label: 'Cut' });
    expect(map.selectedOnMap.value).toBe(true);
    map.select('equipment:e1');
    expect(map.selectedOnMap.value).toBe(false);
  });

  it('hovering a card dims the rest; hovering a wire only highlights it', async () => {
    family.mockResolvedValue(small());
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    map.hover('s:s2', {} as HTMLElement);
    expect(map.focusOfHover.value).toMatchObject({ dim: true });
    map.hover(null);
    expect(map.focusOfHover.value).toBeNull();
    map.hover(map.graph.value!.wires[0].id, {} as HTMLElement);
    expect(map.focusOfHover.value).toMatchObject({ dim: false });
  });

  it('hidden markers become the sides a node draws "some records hidden" on, even with no socket there', async () => {
    const d = small();
    d.hidden = { ancestors: true, descendants: false, events: false, stock: false };
    family.mockResolvedValue(d);
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    const root = map.graph.value!.nodes.find((n) => n.id === 's:s1')!;
    expect(root.type === 'record' && root.ins).toEqual([]); // a root sample has no input socket
    expect([...(map.hiddenSides.value.get('s:s1') ?? [])]).toEqual(['in']);
  });

  describe('the hover card', () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it('opens after 250 ms on a card with an element, not before, and closes when the pointer leaves', async () => {
      family.mockResolvedValue(small());
      const { map } = setup({ focus: 'physical_samples:s1' });
      await vi.advanceTimersByTimeAsync(10);
      const el = {} as HTMLElement;
      map.hover('s:s1', el);
      await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS - 1);
      expect(map.card.value).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(map.card.value).toMatchObject({ id: 's:s1', el, info: { kind: 'sample', code: 'S1' } });
      map.hover(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(map.card.value).toBeNull();
    });

    it('moving to another card restarts the wait; a wire, a socket or an unknown id never opens one', async () => {
      family.mockResolvedValue(small());
      const { map } = setup({ focus: 'physical_samples:s1' });
      await vi.advanceTimersByTimeAsync(10);
      map.hover('s:s1', {} as HTMLElement);
      await vi.advanceTimersByTimeAsync(200);
      map.hover(null);
      map.hover('s:s2', {} as HTMLElement);
      await vi.advanceTimersByTimeAsync(200);
      expect(map.card.value).toBeNull();
      await vi.advanceTimersByTimeAsync(60);
      expect(map.card.value?.id).toBe('s:s2');
      map.hover(null);
      for (const id of [map.graph.value!.wires[0].id, map.graph.value!.wires[0].from, 'nope']) {
        map.hover(id, {} as HTMLElement);
        await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS + 10);
        expect(map.card.value).toBeNull();
        map.hover(null);
      }
    });

    it('a hover without an element (the rail row of a card that is not drawn) opens no card', async () => {
      family.mockResolvedValue(small());
      const { map } = setup({ focus: 'physical_samples:s1' });
      await vi.advanceTimersByTimeAsync(10);
      map.hover('s:s1');
      await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS + 10);
      expect(map.card.value).toBeNull();
    });
  });

  it('toggleRows unfolds one container and moreOpen flips for toggleMore', async () => {
    const data = mkData({
      samples: ['p', 'c0', 'c1', 'c2', 'c3'].map((id) => mkSample(id)),
      operations: ['c0', 'c1', 'c2', 'c3'].map((c, i) =>
        mkOp({ id: `k${i}`, sampleId: 'p', outputSampleId: c, date: '2026-09-01T09:00:00Z', methodName: 'Cut' }),
      ),
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:p' });
    await settle();
    const container = () => map.graph.value!.nodes.find((n) => n.type === 'container') as ContainerNode;
    const id = container().id;
    expect(container().bundled).toBe(true);
    map.toggleRows(id);
    expect(container().bundled).toBe(false);
    map.toggleRows(id);
    expect(container().bundled).toBe(true);
    map.toggleMore(id);
    expect(map.moreOpen.value.has(id)).toBe(true);
    map.toggleMore(id);
    expect(map.moreOpen.value.has(id)).toBe(false);
  });
});
