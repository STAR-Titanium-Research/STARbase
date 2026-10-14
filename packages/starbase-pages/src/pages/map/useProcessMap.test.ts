import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, watch } from 'vue';
import type { HostApi } from '@d1/ui';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkTest } from './model/fixtures';
import type { ContainerNode, MoreNode, OpRow, ProcessData } from './model/types';
import { loadFamily, loadRecordRef, loadRelationDefs, loadStepRow, loadUsedIn } from './model/loadFamily';
import { HOVER_DELAY_MS, useProcessMap } from './useProcessMap';

vi.mock('./model/loadFamily', async (orig) => ({
  ...(await orig<typeof import('./model/loadFamily')>()),
  loadFamily: vi.fn(),
  loadRelationDefs: vi.fn(async () => null),
  loadStepRow: vi.fn(),
  loadRecordRef: vi.fn(),
  loadUsedIn: vi.fn(),
}));

const family = vi.mocked(loadFamily);
const stepRow = vi.mocked(loadStepRow);
const recordRef = vi.mocked(loadRecordRef);
const usedIn = vi.mocked(loadUsedIn);
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

/** `n` operations of a tool (newest first), as loadUsedIn returns them: their samples are not loaded. */
function toolOps(n: number, from = 0): OpRow[] {
  return Array.from({ length: n }, (_, i) =>
    mkOp({ id: `u${from + i}`, code: `OP-${from + i}`, methodName: 'Turning', date: `2026-09-${String(28 - ((from + i) % 28)).padStart(2, '0')}T09:00:00Z`, sampleId: `x${from + i}`, outputSampleId: `y${from + i}` }),
  );
}
const TOOL = { collection: 'tools', id: 't1', code: 'TL-1' };
/** The family of sample `x${i}`: the tool's operation u<i> cutting it into y<i>. */
const familyOfX = (i: number): ProcessData =>
  mkData({
    samples: [mkSample(`x${i}`), mkSample(`y${i}`)],
    operations: [mkOp({ id: `u${i}`, code: `OP-${i}`, methodName: 'Turning', date: '2026-09-01T09:00:00Z', sampleId: `x${i}`, outputSampleId: `y${i}` })],
  });

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
  stepRow.mockReset();
  recordRef.mockReset();
  usedIn.mockReset();
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

  it('a collection the map cannot focus at all says so plainly and loads nothing', async () => {
    const { map } = setup({ focus: 'widgets:w1' });
    await settle();
    expect(map.status.value).toBe('error');
    expect(map.error.value).toBe('The Process map cannot open on this kind of record.');
    for (const load of [family, stepRow, recordRef, usedIn]) expect(load).not.toHaveBeenCalled();
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

  it('the tag of a card from another project is the code of that project when a loaded row names it, else "other project" (M2)', async () => {
    const home = { collection: 'projects', id: 'p1', code: 'PRJ-1' };
    const other = { collection: 'projects', id: 'p2', code: 'PRJ-2', label: 'Wear study' };
    const data = mkData({
      samples: [mkSample('s1', { projectId: 'p1', form: 'disc' }), mkSample('s2', { projectId: 'p2', form: 'disc' }), mkSample('s3', { projectId: 'p3' })],
      operations: [
        mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', relations: { project_id: home }, projectId: 'p1' }),
        mkOp({ id: 'o2', sampleId: 's2', outputSampleId: 's3', date: '2026-09-02T09:00:00Z', relations: { project_id: other }, projectId: 'p2' }),
      ],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:s1', reach: 'all' });
    await settle();
    const meta = (id: string) => (map.nodes.value.find((n) => n.id === id) as { meta?: string }).meta ?? '';
    expect(meta('s:s2')).toBe('disc · project PRJ-2');
    expect(meta('s:s3')).toBe('other project'); // no loaded row names p3
    expect(meta('s:s1')).toBe('disc');
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

  it('setFocus from the empty page opens a tool as its used-in fan, and a collection it cannot focus as the plain state', async () => {
    recordRef.mockResolvedValue({ collection: 'tools', id: 't1', code: 'TL-1' });
    usedIn.mockResolvedValue({ items: toolOps(2), total: 2 });
    const { map } = setup();
    await settle();
    map.setFocus('tools', 't1');
    await settle();
    expect(map.status.value).toBe('ready');
    expect(map.focusNodeId.value).toBe('f:tools:t1');
    map.setFocus('widgets', 'w1');
    await settle();
    expect(map.status.value).toBe('error');
  });

  it('the Finder pick loads a record the map can open, and declines one it cannot, leaving the map as it is (I6)', async () => {
    family.mockResolvedValue(small());
    const { map, replace } = setup({ focus: 'physical_samples:s1' });
    await settle();
    replace.mockClear();
    for (const collection of ['people', 'tools_box', 'cutting_inserts']) {
      expect(map.pickRecord({ collection, id: 'x1' })).toBe(false);
    }
    expect(replace).not.toHaveBeenCalled();
    expect(map.status.value).toBe('ready');
    expect(map.pickRecord({ collection: 'physical_samples', id: 's2' })).not.toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(map.pickRecord({ collection: 'tools', id: 't1' })).not.toBe(false);
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

// ---- focus kinds, used-in fans and expand ------------------------------------------------------

/** What the canvas sees on each change of nodes: the merge hint of that change (it takes it like this). */
function hints(map: ReturnType<typeof useProcessMap>) {
  const seen: unknown[] = [];
  watch(
    () => map.nodes.value,
    () => void seen.push(...map.takeMergeHints()),
  );
  return seen;
}

const containersOf = (map: ReturnType<typeof useProcessMap>) => map.graph.value!.nodes.filter((n): n is ContainerNode => n.type === 'container');
const idsOf = (map: ReturnType<typeof useProcessMap>) => map.graph.value!.nodes.map((n) => n.id);

describe('focus kinds (D20)', () => {
  it('operation focus loads its input sample\'s family and focuses the container', async () => {
    const data = mkData({
      samples: [mkSample('s1'), mkSample('s2')],
      operations: [mkOp({ id: 'o1', code: 'OP-1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
    });
    stepRow.mockResolvedValue(data.operations[0]);
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'manufacturing_operations:o1' });
    await settle();
    expect(stepRow).toHaveBeenCalledWith(api, { collection: 'manufacturing_operations', id: 'o1' });
    expect(family).toHaveBeenCalledWith(api, 's1');
    expect(map.status.value).toBe('ready');
    expect(map.data.value?.focus).toMatchObject({ collection: 'manufacturing_operations', id: 'o1', code: 'OP-1', kind: 'operation' });
    expect(map.focusNodeId.value).toBe('op:o1');
    expect(map.selectedId.value).toBe('op:o1');
    expect(map.selected.value?.ref).toMatchObject({ collection: 'manufacturing_operations', id: 'o1' });
    expect(map.shown.value.has('op:o1')).toBe(true);
    expect(map.shown.value.has('s:s1')).toBe(true);
  });

  it('an operation in a probable batch focuses the batch container it sits in', async () => {
    const data = mkData({
      samples: [mkSample('p'), mkSample('a'), mkSample('b')],
      operations: [
        mkOp({ id: 'x1', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', methodName: 'Cut', methodId: 'm' }),
        mkOp({ id: 'x2', sampleId: 'p', outputSampleId: 'b', date: '2026-09-01T10:00:00Z', methodName: 'Cut', methodId: 'm' }),
      ],
    });
    stepRow.mockResolvedValue(data.operations[1]);
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'manufacturing_operations:x2' });
    await settle();
    expect(map.focusNodeId.value).toMatch(/^probable:/);
    expect(map.shown.value.has(map.focusNodeId.value)).toBe(true);
  });

  it('the operation a map opened on stays selected, as itself, when the Probable batches chip is turned off (I2)', async () => {
    const data = mkData({
      samples: [mkSample('p'), mkSample('a'), mkSample('b')],
      operations: [
        mkOp({ id: 'x1', sampleId: 'p', outputSampleId: 'a', date: '2026-09-01T09:00:00Z', methodName: 'Cut', methodId: 'm' }),
        mkOp({ id: 'x2', sampleId: 'p', outputSampleId: 'b', date: '2026-09-01T10:00:00Z', methodName: 'Cut', methodId: 'm' }),
      ],
    });
    stepRow.mockResolvedValue(data.operations[1]);
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'manufacturing_operations:x2' });
    await settle();
    expect(map.selectedId.value).toMatch(/^probable:/);
    map.setProbable(false);
    await settle();
    expect(map.selectedId.value).toBe('op:x2'); // the row the map was opened on, not the first row of the batch
    expect(map.selected.value?.ref.id).toBe('x2');
    map.setProbable(true);
    await settle();
    expect(map.selectedId.value).toMatch(/^probable:/);
  });

  it('a test focus opens the family of its first subject sample', async () => {
    const test = mkTest({ id: 't1', code: 'T-1', subjectSampleIds: ['s2', 's3'], date: '2026-09-02T09:00:00Z' });
    const data = mkData({ samples: [mkSample('s2'), mkSample('s3')], tests: [test] });
    stepRow.mockResolvedValue(test);
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'test_sessions:t1' });
    await settle();
    expect(family).toHaveBeenCalledWith(api, 's2');
    expect(map.data.value?.focus).toMatchObject({ collection: 'test_sessions', id: 't1', kind: 'test' });
    expect(map.focusNodeId.value).toBe('test:t1');
  });

  it('an operation with no sample says so; one the person may not read is not visible', async () => {
    stepRow.mockResolvedValue(mkOp({ id: 'o1', sampleId: null, outputSampleId: null }));
    const a = setup({ focus: 'manufacturing_operations:o1' });
    await settle();
    expect(a.map.status.value).toBe('error');
    expect(a.map.error.value).toMatch(/no sample/);
    expect(family).not.toHaveBeenCalled();

    stepRow.mockRejectedValue(httpError(404));
    const b = setup({ focus: 'test_sessions:nope' });
    await settle();
    expect(b.map.status.value).toBe('notVisible');
  });

  it('an operation the person may read, on a sample they may not, says so instead of "not visible"', async () => {
    // Found in the browser: a Lab Member can read an operation (its page opens) but not its sample, so the
    // sample's trace is a 404. "This operation does not exist" would be wrong; the sample is what is hidden.
    stepRow.mockResolvedValue(mkOp({ id: 'o1', sampleId: 's9', outputSampleId: null }));
    family.mockRejectedValue(httpError(404));
    const a = setup({ focus: 'manufacturing_operations:o1' });
    await settle();
    expect(a.map.status.value).toBe('error');
    expect(a.map.error.value).toMatch(/can read this operation, but not the sample/);

    stepRow.mockResolvedValue(mkTest({ id: 't1', subjectSampleIds: ['s9'] }));
    const b = setup({ focus: 'test_sessions:t1' });
    await settle();
    expect(b.map.error.value).toMatch(/can read this test, but not the sample/);

    // A server error on the sample's trace is still an error with its own text.
    family.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }));
    const c = setup({ focus: 'manufacturing_operations:o1' });
    await settle();
    expect(c.map.error.value).toContain('boom');
  });

  it('tool focus builds a fan of at most 20 collapsed containers and "+N more"', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(20), total: 47 });
    const { map } = setup({ focus: 'tools:t1', reach: '1' });
    await settle();
    expect(recordRef).toHaveBeenCalledWith(api, { collection: 'tools', id: 't1' });
    expect(usedIn).toHaveBeenCalledWith(api, { collection: 'tools', id: 't1' }, 1);
    expect(map.status.value).toBe('ready');
    expect(map.focusNodeId.value).toBe('f:tools:t1');
    expect(map.selectedId.value).toBe('f:tools:t1');
    const containers = containersOf(map);
    expect(containers).toHaveLength(20);
    expect(containers.every((c) => c.collapsed)).toBe(true);
    const more = map.graph.value!.nodes.find((n): n is MoreNode => n.type === 'more')!;
    expect(more).toMatchObject({ id: 'more:tools:t1', remaining: 27 });
    // Reach does not cut a fan: everything it lists is drawn.
    expect(map.shown.value.size).toBe(22);
    expect(map.nodes.value.map((n) => n.id)).toContain('more:tools:t1');
    expect(map.partial.value).toBe(false);
  });

  it('material focus fans samples as cards', async () => {
    recordRef.mockResolvedValue({ collection: 'materials', id: 'm1', code: 'Ti64' });
    usedIn.mockResolvedValue({ items: [mkSample('a'), mkSample('b'), mkSample('c')], total: 3 });
    const { map } = setup({ focus: 'materials:m1' });
    await settle();
    expect(map.data.value?.focus).toMatchObject({ kind: 'material', collection: 'materials' });
    const kinds = map.nodes.value.map((n) => (n.type === 'record' ? n.kind : n.type));
    expect(kinds.sort()).toEqual(['material', 'sample', 'sample', 'sample']);
    expect(map.graph.value!.nodes.some((n) => n.type === 'more')).toBe(false);
  });

  it('project and campaign focus open the same sample fan; an equipment focus lists operations and tests', async () => {
    recordRef.mockResolvedValue({ collection: 'projects', id: 'p1', code: 'PRJ-1' });
    usedIn.mockResolvedValue({ items: [mkSample('a')], total: 1 });
    const a = setup({ focus: 'projects:p1' });
    await settle();
    expect(a.map.focusNodeId.value).toBe('f:projects:p1');
    expect(a.map.project.value).toMatchObject({ collection: 'projects', code: 'PRJ-1' }); // the frame names the project

    recordRef.mockResolvedValue({ collection: 'equipment', id: 'e1', code: 'NLX' });
    usedIn.mockResolvedValue({ items: toolOps(1), total: 1, tests: [mkTest({ id: 'tt1', code: 'T-9', date: '2026-09-03T09:00:00Z' })], testsTotal: 1 });
    const b = setup({ focus: 'equipment:e1' });
    await settle();
    expect(containersOf(b.map).map((c) => c.kind).sort()).toEqual(['operation', 'test']);
  });

  it('a fan root the person may not read is not visible; a failed read is an error', async () => {
    recordRef.mockRejectedValue(httpError(403));
    usedIn.mockResolvedValue({ items: [], total: 0 });
    const a = setup({ focus: 'tools:t1' });
    await settle();
    expect(a.map.status.value).toBe('notVisible');
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }));
    const b = setup({ focus: 'tools:t1' });
    await settle();
    expect(b.map.status.value).toBe('error');
    expect(b.map.error.value).toContain('boom');
  });
});

describe('expand: loading more (D15, spec 7)', () => {
  async function toolFan(total = 47, extra: Record<string, unknown> = {}) {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(20), total });
    const s = setup({ focus: 'tools:t1', ...extra });
    await settle();
    return s;
  }

  it('expanding a collapsed container merges its family without duplicating nodes, and the container opens', async () => {
    const { map } = await toolFan();
    const seen = hints(map);
    family.mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    await settle();
    expect(family).toHaveBeenLastCalledWith(api, 'x0');
    const ids = idsOf(map);
    expect(new Set(ids).size).toBe(ids.length);
    const opened = containersOf(map).find((c) => c.id === 'op:u0')!;
    expect(opened.collapsed).toBeUndefined();
    expect(opened.rows[0]).toMatchObject({ sampleId: 'y0' });
    expect(containersOf(map).filter((c) => c.collapsed)).toHaveLength(19);
    expect(map.data.value?.fan?.items.some((i) => i.id === 'u0')).toBe(false);
    expect(map.data.value?.operations.filter((o) => o.id === 'u0')).toHaveLength(1);
    expect(ids).toContain('s:x0');
    expect(map.shown.value.has('s:y0')).toBe(true);
    // The layout is told to keep what is placed and open the card where it is.
    expect(seen.at(-1)).toMatchObject({ anchor: 'op:u0', from: 'op:u0' });
    // The focus (and the selection) did not move.
    expect(map.focusNodeId.value).toBe('f:tools:t1');
    expect(map.generation.value).toBe(1);
  });

  it('an opened step that joins a probable batch hands its place to the batch container', async () => {
    const { map } = await toolFan();
    const seen = hints(map);
    const fam = familyOfX(0);
    fam.operations[0] = { ...fam.operations[0], date: '2026-09-28T09:00:00Z' }; // the family read of u0: the same day as its twin (the family's copy of a row is the one drawn)
    fam.samples.push(mkSample('z0'));
    fam.operations.push(mkOp({ id: 'twin', sampleId: 'x0', outputSampleId: 'z0', date: '2026-09-28T10:00:00Z', methodName: 'Turning', methodId: fam.operations[0].methodId }));
    family.mockResolvedValue(fam);
    await map.expand('op:u0');
    await settle();
    const hint = seen.at(-1) as { anchor: string; from: string };
    expect(hint.from).toBe('op:u0');
    expect(hint.anchor).toMatch(/^probable:/);
    expect(map.shown.value.has(hint.anchor)).toBe(true);
  });

  it('"+N more" loads the next page of the fan and moves the stub; a second click while it loads does nothing', async () => {
    const { map } = await toolFan(47);
    const seen = hints(map);
    usedIn.mockResolvedValue({ items: toolOps(20, 20), total: 47 });
    const first = map.expand('more:tools:t1');
    const second = map.expand('more:tools:t1');
    await Promise.all([first, second]);
    await settle();
    expect(usedIn).toHaveBeenCalledTimes(2); // the first page and this one
    expect(usedIn).toHaveBeenLastCalledWith(api, { collection: 'tools', id: 't1' }, 2);
    expect(containersOf(map)).toHaveLength(40);
    expect(map.graph.value!.nodes.find((n): n is MoreNode => n.type === 'more')?.remaining).toBe(7);
    expect(seen.at(-1)).toMatchObject({ replace: ['more:tools:t1'] });

    usedIn.mockResolvedValue({ items: toolOps(7, 40), total: 47 });
    await map.expand('more:tools:t1');
    await settle();
    expect(containersOf(map)).toHaveLength(47);
    expect(map.graph.value!.nodes.some((n) => n.type === 'more')).toBe(false);
  });

  it('a stock lot page with no operations is not the end: "+N more" stays and loads the next page', async () => {
    recordRef.mockResolvedValue({ collection: 'raw_stock_lots', id: 'l1', code: 'LOT-1' });
    usedIn.mockResolvedValue({ items: [], total: 45 });
    const { map } = setup({ focus: 'raw_stock_lots:l1' });
    await settle();
    expect(map.focusNodeId.value).toBe('lot:l1');
    expect(map.graph.value!.nodes.find((n): n is MoreNode => n.type === 'more')?.remaining).toBe(25);
    usedIn.mockResolvedValue({ items: toolOps(2), total: 45 });
    await map.expand('more:raw_stock_lots:l1');
    await settle();
    expect(containersOf(map)).toHaveLength(2);
    expect(map.graph.value!.nodes.find((n): n is MoreNode => n.type === 'more')?.remaining).toBe(5);
  });

  it('a sample card of a fan opens its family once; after that the plus button reveals what is one step beyond it', async () => {
    recordRef.mockResolvedValue({ collection: 'materials', id: 'm1', code: 'Ti64' });
    usedIn.mockResolvedValue({ items: [mkSample('a'), mkSample('b')], total: 2 });
    const { map } = setup({ focus: 'materials:m1' });
    await settle();
    family.mockResolvedValue(
      mkData({
        samples: [mkSample('a'), mkSample('a1'), mkSample('a2')],
        operations: [
          mkOp({ id: 'k1', sampleId: 'a', outputSampleId: 'a1', date: '2026-09-01T09:00:00Z', methodName: 'Cut' }),
          mkOp({ id: 'k2', sampleId: 'a1', outputSampleId: 'a2', date: '2026-09-02T09:00:00Z', methodName: 'Cut' }),
        ],
      }),
    );
    await map.expand('s:a');
    await settle();
    expect(family).toHaveBeenCalledTimes(1);
    expect(family).toHaveBeenCalledWith(api, 'a');
    const ids = idsOf(map);
    expect(new Set(ids).size).toBe(ids.length);
    expect(map.shown.value.has('s:a1')).toBe(true);
    expect(map.shown.value.has('s:a2')).toBe(false);
    await map.expand('s:a1'); // its family is loaded: one more step
    expect(family).toHaveBeenCalledTimes(1);
    expect(map.shown.value.has('s:a2')).toBe(true);
  });

  it('plus on a record inside an Inside tray merges its used-in fan beside that container', async () => {
    const tool = { collection: 'tools', id: 't1', code: 'TL-1' };
    const data = mkData({
      samples: [mkSample('s1'), mkSample('s2')],
      operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut', relations: { tool_id: tool } })],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    const seen = hints(map);
    usedIn.mockResolvedValue({ items: [...toolOps(2), mkOp({ id: 'o1', sampleId: 's1' })], total: 3 });
    await map.expand('tools:t1');
    await settle();
    expect(usedIn).toHaveBeenCalledWith(api, tool, 1);
    expect(idsOf(map)).toEqual(expect.arrayContaining(['f:tools:t1', 'op:u0', 'op:u1']));
    expect(containersOf(map).filter((c) => c.collapsed).map((c) => c.id)).toEqual(['op:u0', 'op:u1']); // o1 is already drawn in full
    expect(map.shown.value.has('f:tools:t1')).toBe(true);
    expect(map.shown.value.has('op:u0')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ anchor: 'op:o1' });
    // Reach does not take the fan away again.
    map.setReach(1);
    expect(map.shown.value.has('op:u1')).toBe(true);
    // Asking again does not load it twice.
    await map.expand('tools:t1');
    expect(usedIn).toHaveBeenCalledTimes(1);
    expect(map.notice.value).toMatch(/already open/);
  });

  it('plus on a record with no fan (a person, a data file) does nothing', async () => {
    const data = mkData({ samples: [mkSample('s1'), mkSample('s2')], operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', relations: { operator_person_id: { collection: 'people', id: 'pp', code: 'Ada' } } })] });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    await map.expand('people:pp');
    expect(usedIn).not.toHaveBeenCalled();
  });

  it('a record nothing else used says so and adds nothing', async () => {
    const tool = { collection: 'tools', id: 't1', code: 'TL-1' };
    const op = mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', relations: { tool_id: tool } });
    family.mockResolvedValue(mkData({ samples: [mkSample('s1'), mkSample('s2')], operations: [op] }));
    const { map } = setup({ focus: 'physical_samples:s1' });
    await settle();
    usedIn.mockResolvedValue({ items: [op], total: 1 });
    await map.expand('tools:t1');
    expect(map.notice.value).toMatch(/Nothing else/);
    expect(idsOf(map)).not.toContain('f:tools:t1');
  });

  it('a failed expand shows the error and keeps what is loaded', async () => {
    const { map } = await toolFan();
    family.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }));
    const before = map.nodes.value.length;
    await map.expand('op:u0');
    expect(map.notice.value).toContain('boom');
    expect(map.expanding.value).toBe(0);
    expect(map.status.value).toBe('ready');
    expect(map.nodes.value).toHaveLength(before);
    expect(containersOf(map).every((c) => c.collapsed)).toBe(true);
    // The next expand clears it.
    family.mockResolvedValue(familyOfX(1));
    await map.expand('op:u1');
    expect(map.notice.value).toBe('');
  });

  it('a collapsed step with no sample cannot open its family', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: [mkOp({ id: 'bare', code: 'OP-BARE', sampleId: null, outputSampleId: null })], total: 1 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    await map.expand('op:bare');
    expect(family).not.toHaveBeenCalled();
    expect(map.notice.value).toMatch(/no sample/);
  });

  it('the result of an expand that outlives its focus is dropped', async () => {
    const { map, route } = await toolFan();
    let release!: (d: ProcessData) => void;
    family.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const pending = map.expand('op:u0');
    recordRef.mockResolvedValue({ collection: 'tools', id: 't2', code: 'TL-2' });
    usedIn.mockResolvedValue({ items: toolOps(1, 100), total: 1 });
    route.query = { focus: 'tools:t2' };
    await settle();
    release(familyOfX(0));
    await pending;
    await settle();
    expect(map.focusNodeId.value).toBe('f:tools:t2');
    expect(idsOf(map)).not.toContain('s:x0');
    expect(map.expanding.value).toBe(0);
  });

  it('a new focus is a new generation for the canvas; an expand is not', async () => {
    const { map, route } = await toolFan();
    const g = map.generation.value;
    family.mockResolvedValue(familyOfX(0));
    await map.expand('op:u0');
    expect(map.generation.value).toBe(g);
    recordRef.mockResolvedValue({ collection: 'tools', id: 't2', code: 'TL-2' });
    usedIn.mockResolvedValue({ items: [], total: 0 });
    route.query = { focus: 'tools:t2' };
    await settle();
    expect(map.generation.value).toBeGreaterThan(g);
  });
});

describe('the 300-card cap applies to what plus reveals (D22)', () => {
  /** a -> b by one operation, b -> 350 pieces by one batch: b's step beyond is 351 cards. */
  function broad(): ProcessData {
    const kids = Array.from({ length: 350 }, (_, i) => `k${i}`);
    return mkData({
      samples: ['a', 'b', ...kids].map((id) => mkSample(id)),
      operations: [
        mkOp({ id: 'first', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' }),
        ...kids.map((k, i) => mkOp({ id: `cut${i}`, sampleId: 'b', outputSampleId: k, date: '2026-09-02T09:00:00Z', methodName: 'Cut', methodId: 'm' })),
      ],
    });
  }

  it('stops adding at 300 cards and sets the banner', async () => {
    family.mockResolvedValue(broad());
    const { map } = setup({ focus: 'physical_samples:a', reach: '1' });
    await settle();
    expect(map.partial.value).toBe(false);
    const before = map.shown.value.size;
    expect(before).toBeLessThan(10);
    await map.expand('s:b');
    expect(map.shown.value.size).toBe(300);
    expect(map.partial.value).toBe(true);
    // Another click cannot add past it either.
    await map.expand('s:b');
    expect(map.shown.value.size).toBe(300);
    // A new reach starts again.
    map.setReach(1);
    expect(map.shown.value.size).toBe(before);
    expect(map.partial.value).toBe(false);
  });

  it('a family merged by plus stops at the cap too, and "+N more" does not load a page that would not fit', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(20), total: 47 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    const fam = broad();
    fam.operations[0] = mkOp({ id: 'u0', sampleId: 'x0', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'Cut' });
    fam.samples[0] = mkSample('x0');
    fam.operations.slice(1).forEach((o) => (o.sampleId = 'x0'));
    family.mockResolvedValue(fam);
    await map.expand('op:u0');
    await settle();
    expect(map.shown.value.size).toBeLessThanOrEqual(300);
    expect(map.partial.value).toBe(true);
    const items = map.data.value!.fan!.items.length;
    usedIn.mockResolvedValue({ items: toolOps(20, 20), total: 47 });
    await map.expand('more:tools:t1');
    expect(map.data.value!.fan!.items).toHaveLength(items); // nothing added
    expect(map.graph.value!.nodes.some((n) => n.type === 'more')).toBe(true);
    expect(map.partial.value).toBe(true);
  });
});

describe('expand inside a loaded family still reveals one step and tells the layout to keep what is placed', () => {
  it('hands the canvas a merge hint naming the card', async () => {
    const data = mkData({
      samples: ['a', 'b', 'c'].map((id) => mkSample(id)),
      operations: [
        mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z', methodName: 'M' }),
        mkOp({ id: 'o2', sampleId: 'b', outputSampleId: 'c', date: '2026-09-02T09:00:00Z', methodName: 'M' }),
      ],
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:a', reach: '1' });
    await settle();
    const seen = hints(map);
    await map.expand('s:b');
    await settle();
    expect(seen.at(-1)).toEqual({ anchor: 's:b' });
    expect(map.shown.value.has('s:c')).toBe(true);
    // A change that is not an expand carries no hint (the canvas lays everything out).
    map.toggleKind('stock_lot');
    await settle();
    expect(map.takeMergeHints()).toEqual([]);
  });
});

describe('expanding a fan item keeps the rest of the list on the map', () => {
  /** u0..u3 are passes of one tool on the same sample, three or more steps apart; u4 is on another sample. */
  async function passes() {
    recordRef.mockResolvedValue(TOOL);
    const ops = [0, 1, 2, 3].map((i) =>
      mkOp({ id: `u${i}`, code: `OP-${i}`, methodName: 'Polish', date: `2026-09-${String(10 + i).padStart(2, '0')}T09:00:00Z`, sampleId: 'x0', outputSampleId: 'x0' }),
    );
    usedIn.mockResolvedValue({ items: [...ops, ...toolOps(1).map((o) => ({ ...o, id: 'u4', sampleId: 'x4', outputSampleId: 'y4' }))], total: 5 });
    const s = setup({ focus: 'tools:t1' });
    await settle();
    family.mockResolvedValue(mkData({ samples: [mkSample('x0')], operations: ops }));
    return s;
  }

  it('a family that holds other passes of the same tool does not make them vanish', async () => {
    const { map } = await passes();
    expect(map.shown.value.has('op:u3')).toBe(true);
    await map.expand('op:u0');
    await settle();
    for (const id of ['op:u0', 'op:u1', 'op:u2', 'op:u3', 'op:u4']) expect(map.shown.value.has(id), id).toBe(true);
    expect(containersOf(map).filter((c) => !c.collapsed).map((c) => c.id).sort()).toEqual(['op:u0', 'op:u1', 'op:u2', 'op:u3']);
  });

  it('at the 300-card cap the card that was opened, and the others the family holds, stay', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(20), total: 20 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    // First fill the map to the cap with a broad family under u5.
    const kids = Array.from({ length: 350 }, (_, i) => `k${i}`);
    family.mockResolvedValueOnce(
      mkData({
        samples: ['x5', 'y5', ...kids].map((id) => mkSample(id)),
        operations: [
          mkOp({ id: 'u5', code: 'OP-5', methodName: 'Turning', sampleId: 'x5', outputSampleId: 'y5', date: '2026-09-23T09:00:00Z' }),
          ...kids.map((k, i) => mkOp({ id: `c${i}`, sampleId: 'y5', outputSampleId: k, date: '2026-09-24T09:00:00Z', methodName: 'Cut', methodId: 'm' })),
        ],
      }),
    );
    await map.expand('op:u5');
    await settle();
    expect(map.shown.value.size).toBe(300);
    // Now open u1 whose family also holds u2 as a pass on the same sample: no room, but neither card goes.
    family.mockResolvedValueOnce(
      mkData({
        samples: [mkSample('x1')],
        operations: ['u1', 'u2'].map((id, i) => mkOp({ id, sampleId: 'x1', outputSampleId: 'x1', methodName: 'Polish', date: `2026-09-${20 + i}T09:00:00Z` })),
      }),
    );
    await map.expand('op:u1');
    await settle();
    expect(map.shown.value.has('op:u1')).toBe(true);
    expect(map.shown.value.has('op:u2')).toBe(true);
    expect(containersOf(map).find((c) => c.id === 'op:u1')?.collapsed).toBeUndefined();
    expect(map.partial.value).toBe(true);
  });
});

describe('a remembered Show chip never hides the focus or a fan\'s own card', () => {
  it('hidden: ["tool"] still shows the tool a fan hangs from', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ hidden: ['tool', 'material', 'project'], probable: true }), setItem: () => undefined });
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(3), total: 3 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    expect(map.hiddenKinds.value.has('tool')).toBe(true);
    expect(map.shown.value.has('f:tools:t1')).toBe(true);
    expect(map.nodes.value.map((n) => n.id)).toContain('f:tools:t1');

    recordRef.mockResolvedValue({ collection: 'materials', id: 'm1', code: 'Ti64' });
    usedIn.mockResolvedValue({ items: [mkSample('a')], total: 1 });
    const mat = setup({ focus: 'materials:m1' });
    await settle();
    expect(mat.map.shown.value.has('f:materials:m1')).toBe(true);
  });
});

describe('cards opened from a side fan', () => {
  const tool = { collection: 'tools', id: 't1', code: 'TL-1' };
  async function withSideFan() {
    family.mockResolvedValueOnce(
      mkData({
        samples: [mkSample('s1'), mkSample('s2')],
        operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut', relations: { tool_id: tool } })],
      }),
    );
    const s = setup({ focus: 'physical_samples:s1', reach: '1' });
    await settle();
    usedIn.mockResolvedValue({ items: toolOps(3), total: 3 });
    await s.map.expand('tools:t1');
    await settle();
    return s;
  }

  it('an item opened from the side fan, and its samples, stay when Reach changes', async () => {
    const { map } = await withSideFan();
    family.mockResolvedValueOnce(familyOfX(1));
    await map.expand('op:u1');
    await settle();
    for (const id of ['op:u1', 's:x1', 's:y1']) expect(map.shown.value.has(id), id).toBe(true);
    map.setReach(3);
    await settle();
    for (const id of ['op:u1', 's:x1', 's:y1', 'f:tools:t1', 'op:u0']) expect(map.shown.value.has(id), id).toBe(true);
    // and the tool is not "already open" with nothing to show for it
    expect(containersOf(map).find((c) => c.id === 'op:u1')?.collapsed).toBeUndefined();
  });

  it('a second plus on a collapsed container while its family loads is ignored', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(3), total: 3 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    family.mockResolvedValue(familyOfX(0));
    await Promise.all([map.expand('op:u0'), map.expand('op:u0')]);
    await settle();
    expect(family).toHaveBeenCalledTimes(1);
    expect(map.expanding.value).toBe(0);
    // once it is open it can be asked again (it reveals a step; no second load)
    await map.expand('op:u0');
    expect(family).toHaveBeenCalledTimes(1);
  });

  it('an old failure notice goes away when a later expand merges', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(3), total: 3 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    family.mockRejectedValueOnce(new Error('boom'));
    await map.expand('op:u0');
    expect(map.notice.value).toMatch(/Could not load more/);
    map.notice.value = 'stale';
    family.mockResolvedValue(familyOfX(1));
    await map.expand('op:u1');
    expect(map.notice.value).toBe('');
  });
});

describe('expands in one tick and across focuses', () => {
  async function fan(id = 't1') {
    recordRef.mockResolvedValue({ collection: 'tools', id, code: id.toUpperCase() });
    usedIn.mockResolvedValue({ items: toolOps(4), total: 4 });
    return setup({ focus: `tools:${id}` });
  }

  it('two merges published in the same tick both reach the layout, in one batch', async () => {
    const { map } = await fan();
    await settle();
    const batches: { anchor?: string }[][] = [];
    watch(
      () => map.nodes.value,
      () => void batches.push(map.takeMergeHints()),
    );
    family.mockImplementation(async (_api, id) => familyOfX(Number(String(id).slice(1))));
    await Promise.all([map.expand('op:u0'), map.expand('op:u1')]);
    await settle();
    const all = batches.flat();
    expect(all.map((h) => h.anchor).sort()).toEqual(['op:u0', 'op:u1']);
    expect(batches.filter((b) => b.length === 2)).toHaveLength(1); // one change, both hints
    // and nothing is left behind for an unrelated change to pick up
    expect(map.takeMergeHints()).toEqual([]);
  });

  it('a plus in flight when the focus changes does not swallow the same plus in the new focus', async () => {
    const { map, route } = await fan('t1');
    await settle();
    let release!: (d: ProcessData) => void;
    family.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const old = map.expand('op:u0');
    route.query = { focus: 'tools:t2' };
    recordRef.mockResolvedValue({ collection: 'tools', id: 't2', code: 'T2' });
    await settle();
    family.mockResolvedValue(familyOfX(0));
    await map.expand('op:u0'); // same card key in the new focus
    await settle();
    expect(family).toHaveBeenCalledTimes(2);
    expect(containersOf(map).find((c) => c.id === 'op:u0')?.collapsed).toBeUndefined();
    release(familyOfX(0));
    await old;
  });

  it('a paging key of the old focus is forgotten too', async () => {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValueOnce({ items: toolOps(20), total: 47 });
    const { map, route } = setup({ focus: 'tools:t1' });
    await settle();
    usedIn.mockImplementationOnce(() => new Promise(() => undefined)); // never answers
    void map.expand('more:tools:t1');
    route.query = { focus: 'tools:t2' };
    recordRef.mockResolvedValue({ collection: 'tools', id: 't2', code: 'T2' });
    usedIn.mockResolvedValueOnce({ items: toolOps(20), total: 47 });
    await settle();
    usedIn.mockResolvedValueOnce({ items: toolOps(20, 20), total: 47 });
    await map.expand('more:tools:t2');
    expect(containersOf(map)).toHaveLength(40);
    // the key that was in flight under the old focus (tools:t1) can be asked for again
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValueOnce({ items: toolOps(20), total: 47 });
    route.query = { focus: 'tools:t1' };
    await settle();
    usedIn.mockResolvedValueOnce({ items: toolOps(20, 20), total: 47 });
    await map.expand('more:tools:t1');
    expect(containersOf(map)).toHaveLength(40);
  });
});

describe('a piece outside the family (C1)', () => {
  const DAY = '2026-03-04T09:00:00Z';
  const seenFromA = (): ProcessData =>
    mkData({
      focus: { collection: 'physical_samples', id: 'a', code: 'A', kind: 'sample' },
      samples: [mkSample('s'), mkSample('a')],
      operations: ['a', 'b'].map((p) => mkOp({ id: `cut-${p}`, sampleId: 's', outputSampleId: p, date: DAY, methodName: 'Cut', equipmentId: 'saw' })),
    });

  it('plus on its card opens its family and the card becomes the real sample', async () => {
    family.mockResolvedValue(seenFromA());
    const { map } = setup({ focus: 'physical_samples:a', reach: 'all' });
    await settle();
    expect(map.nodes.value.find((n) => n.id === 's:b')).toMatchObject({ kind: 'sample', ref: { id: 'b', code: 'another piece' } });
    family.mockResolvedValue(
      mkData({ samples: [mkSample('s'), mkSample('b', { code: 'S-1B' })], operations: [mkOp({ id: 'cut-b', sampleId: 's', outputSampleId: 'b', date: DAY, methodName: 'Cut', equipmentId: 'saw' })] }),
    );
    await map.expand('s:b');
    await settle();
    expect(family).toHaveBeenLastCalledWith(api, 'b');
    expect(map.graph.value?.nodes.find((n) => n.id === 's:b')).toMatchObject({ ref: { code: 'S-1B' } });
  });
});

describe('toggling Probable batches keeps what the person opened (I2)', () => {
  const DAY = '2026-09-28T09:00:00Z';
  async function openedCut() {
    recordRef.mockResolvedValue(TOOL);
    usedIn.mockResolvedValue({ items: toolOps(3), total: 3 });
    const { map } = setup({ focus: 'tools:t1' });
    await settle();
    // x0 was cut three times the same day: its family groups u0 with its two siblings
    family.mockResolvedValue(
      mkData({
        samples: ['x0', 'y0', 'y0b', 'y0c'].map((id) => mkSample(id)),
        operations: [
          mkOp({ id: 'u0', code: 'OP-0', methodName: 'Turning', date: DAY, sampleId: 'x0', outputSampleId: 'y0' }),
          mkOp({ id: 'u0b', methodName: 'Turning', date: DAY, sampleId: 'x0', outputSampleId: 'y0b' }),
          mkOp({ id: 'u0c', methodName: 'Turning', date: DAY, sampleId: 'x0', outputSampleId: 'y0c' }),
        ],
      }),
    );
    await map.expand('op:u0');
    await settle();
    return map;
  }

  it('the cards plus revealed are still drawn after the chip is turned off and on', async () => {
    const map = await openedCut();
    const group = containersOf(map).find((c) => c.group.rowIds.includes('u0'))!;
    expect(group.probable).toBe(true);
    expect(map.shown.value.has(group.id)).toBe(true);
    map.setProbable(false);
    await settle();
    for (const id of ['op:u0', 'op:u0b', 'op:u0c', 's:x0', 's:y0']) expect(map.shown.value.has(id), `${id} off`).toBe(true);
    map.setProbable(true);
    await settle();
    expect(map.shown.value.has(group.id)).toBe(true);
    expect(map.shown.value.has('s:y0')).toBe(true);
  });

  it('the selection follows its record: a container stays selected as the op it holds, a sample as itself', async () => {
    const map = await openedCut();
    const group = containersOf(map).find((c) => c.group.rowIds.includes('u0'))!;
    map.select(group.id);
    map.setProbable(false);
    await settle();
    expect(map.selectedId.value).toBe('op:u0');
    expect(map.selected.value?.ref.id).toBe('u0');
    map.select('s:y0');
    map.setProbable(true);
    await settle();
    expect(map.selectedId.value).toBe('s:y0');
  });

  it('an unfolded container and an opened "more" stay open across the toggle', async () => {
    const data = mkData({
      samples: ['p', 'c0', 'c1', 'c2', 'c3'].map((id) => mkSample(id)),
      operations: ['c0', 'c1', 'c2', 'c3'].map((c, i) => mkOp({ id: `k${i}`, sampleId: 'p', outputSampleId: c, date: DAY, methodName: 'Cut' })),
    });
    family.mockResolvedValue(data);
    const { map } = setup({ focus: 'physical_samples:p' });
    await settle();
    const group = containersOf(map)[0];
    map.toggleRows(group.id);
    map.toggleMore(group.id);
    expect(containersOf(map)[0].bundled).toBe(false);
    map.setProbable(false);
    // four single operations now: one of them still reports the opened "more"
    expect(containersOf(map).some((c) => map.moreOpen.value.has(c.id))).toBe(true);
    map.setProbable(true);
    expect(containersOf(map)[0].bundled).toBe(false);
    expect(map.moreOpen.value.has(containersOf(map)[0].id)).toBe(true);
  });
});

describe('the form relations reach the loader (I7)', () => {
  const runtime = [{ field: 'cutting_fluid_id', label: 'Cutting fluid', collection: 'cutting_fluids', key: 'fluid_id' }];
  /** The relation defs are cached per api: each test has its own. */
  function own(query: Record<string, unknown>) {
    const mine = {} as HostApi;
    const route = reactive({ path: '/map', query: { ...query } as Record<string, unknown> });
    return { mine, map: useProcessMap(mine, route, { replace: vi.fn() }) };
  }

  it('with the relations of the forms read at runtime, loadFamily is given them, for a focus and for a plus', async () => {
    vi.mocked(loadRelationDefs).mockResolvedValue(runtime);
    family.mockResolvedValue(mkData({ samples: [mkSample('s1')], operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z' })] }));
    const { mine, map } = own({ focus: 'physical_samples:s1' });
    await settle();
    expect(family).toHaveBeenLastCalledWith(mine, 's1', { operation: runtime, test: runtime });
    family.mockResolvedValue(mkData({ samples: [mkSample('s2'), mkSample('s3')], operations: [mkOp({ id: 'o9', sampleId: 's2', outputSampleId: 's3' })] }));
    await map.expand('s:s2');
    await settle();
    expect(family).toHaveBeenLastCalledWith(mine, 's2', { operation: runtime, test: runtime });
  });

  it('with the relations refused, loadFamily is called as before and the fallback list is used', async () => {
    vi.mocked(loadRelationDefs).mockResolvedValue(null);
    family.mockResolvedValue(small());
    const { mine } = own({ focus: 'physical_samples:s1' });
    await settle();
    expect(family).toHaveBeenLastCalledWith(mine, 's1');
  });
});
