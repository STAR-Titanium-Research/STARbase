import { describe, expect, it, vi } from 'vitest';
import { computed, nextTick, reactive, ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, ProcessData } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import { BEFORE_RECORDED } from './insertModel';
import { ALREADY_GOING, DONE_WIRE } from './removal';
import { toGraph } from './toGraph';
import { useAddMenu } from './useAddMenu';
import { useEditInsert } from './useEditInsert';
import { useEditMode } from './useEditMode';

// Insert before / after the selected card and a drop on a wire, with the page's pieces faked.

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const turning = { kind: 'operation', methodId: 'mt', category: 'machining' } as const;

/** s1 (done) -> o1 (done) -> s2 (done); the draft is on top of it. */
const loaded = (): ProcessData =>
	mkData({
		samples: [mkSample('s1', { status: 'active' }), mkSample('s2', { status: 'active' })],
		operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', date: '2026-09-01T09:00:00Z' })],
	});

async function setup(body: DraftBody, over: { loaded?: ProcessData | null; selected?: string | null } = {}) {
	const server = fakeServer();
	server.s.seed('d', body);
	server.s.rows = { physical_samples: [{ sample_id: 's2', version: 3 }, { sample_id: 's1', version: 2 }] };
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
	await settle();
	await nextTick();
	const data = over.loaded === undefined ? null : over.loaded;
	const graph = computed(() => {
		const d = toGraph(data, edit.body.value);
		return buildGraph(d, groupBatches(d.operations, d.tests, { probable: false, stack: true }), { slots: () => [] });
	});
	const selectedId = ref<string | null>(over.selected ?? null);
	const said: { text: string; at?: { x: number; y: number } }[] = [];
	const map = { graph, selectedId } as never;
	const canvasEl = ref(null);
	const ensure = vi.fn(async (id: string) => {
		const had = edit.body.value.items.some((i) => i.existing?.id === id);
		if (!had) edit.apply({ type: 'addExistingSamples', samples: [{ id, version: 1 }] });
		return true;
	});
	let insert!: ReturnType<typeof useEditInsert>;
	const menu = useAddMenu({
		edit,
		canvas: { toFlow: (x, y) => ({ x, y }) },
		canvasEl,
		ensureSample: ensure,
		pickSamples: () => undefined,
		connect: () => undefined,
		insert: (t, c) => insert.choose(t, c),
	});
	const nameOf = (n: MapNode) => (n.type === 'record' ? n.ref.code : 'the card');
	const sampleActions = vi.fn(async (id: string): Promise<DraftAction[] | null> => (edit.body.value.items.some((i) => i.existing?.id === id) ? [] : [{ type: 'addExistingSamples', samples: [{ id, version: 1 }] }]));
	insert = useEditInsert({ edit, map, canvasEl, sampleActions, open: menu.open, nameOf, say: (text, at) => void said.push({ text, at }) });
	const wireOf = (from: string, to: string) => graph.value.wires.find((w) => nodeOfSocket(w.from) === from && nodeOfSocket(w.to) === to)!.id;
	return { edit, insert, menu, said, graph, selectedId, ensure, sampleActions, wireOf };
}

/** n1 sample -> n2 operation (row n3) -> n4 sample. */
const chain = (): DraftBody =>
	run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);

describe('Insert before and after the selected card', () => {
	it('opens the add search for the selected card, as an insert, anchored to it', async () => {
		const { insert, menu } = await setup(chain(), { selected: 's:draft:n4' });
		expect(insert.openFor('before')).toBe(true);
		expect(menu.target.value).toMatchObject({ sock: null, anchor: 's:draft:n4', insert: { where: 'before', nodeId: 's:draft:n4' } });
	});

	it('does nothing (the key is the browser\'s) when nothing, or something that cannot be inserted around, is selected', async () => {
		const { insert, menu, selectedId } = await setup(chain());
		expect(insert.openFor('after')).toBe(false);
		selectedId.value = 'nope';
		expect(insert.openFor('after')).toBe(false);
		expect(menu.target.value).toBeNull();
	});

	it('a choice puts the operation in, as ONE undo step', async () => {
		const { insert, menu, edit } = await setup(chain(), { selected: 's:draft:n4' });
		const before = edit.body.value;
		insert.openFor('before');
		await menu.choose(turning);
		expect(edit.body.value.items.filter((i) => i.kind === 'operation')).toHaveLength(2);
		edit.undo();
		expect(edit.body.value).toEqual(before);
	});

	it('before a DONE sample is refused up front: the reason is said, no search opens, the draft is untouched and there is no undo step', async () => {
		const { insert, menu, edit, said, sampleActions } = await setup(emptyBody(), { loaded: loaded(), selected: 's:s2' });
		expect(insert.openFor('before')).toBe(true);
		expect(said).toEqual([{ text: BEFORE_RECORDED, at: undefined }]);
		expect(menu.target.value).toBeNull();
		expect(sampleActions).not.toHaveBeenCalled();
		expect(edit.body.value.items).toEqual([]);
		expect(edit.draft.canUndo.value).toBe(false);
		// The menu is told why, to show "Insert before…" disabled; after is still offered.
		expect(insert.canInsert(insert.selected())).toBe(true);
		expect(insert.beforeRefusal(insert.selected())).toBe(BEFORE_RECORDED);
	});

	it('before a planned sample that is saved is refused the same way', async () => {
		const data = mkData({ samples: [mkSample('s4', { status: 'planned' })] });
		const { insert, menu, edit, said } = await setup(emptyBody(), { loaded: data, selected: 's:s4' });
		expect(insert.openFor('before')).toBe(true);
		expect(said.map((s) => s.text)).toEqual([BEFORE_RECORDED]);
		expect(menu.target.value).toBeNull();
		expect(edit.draft.canUndo.value).toBe(false);
	});

	it('before a new sample still opens the search, and a new card has no refusal', async () => {
		const { insert, menu, said } = await setup(chain(), { selected: 's:draft:n4' });
		expect(insert.beforeRefusal(insert.selected())).toBeNull();
		expect(insert.openFor('before')).toBe(true);
		expect(said).toEqual([]);
		expect(menu.target.value?.insert).toMatchObject({ where: 'before' });
	});

	it('after a done sample: a new operation it feeds; the sample joins the draft with the operation as one step', async () => {
		const { insert, menu, edit } = await setup(emptyBody(), { loaded: loaded(), selected: 's:s2' });
		insert.openFor('after');
		await menu.choose(turning);
		expect(edit.body.value.items.map((i) => i.kind).sort()).toEqual(['operation', 'sample']);
		expect(edit.body.value.wires).toHaveLength(1);
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
	});

	it('an operation chosen from a stale search before a done sample is refused whole, with the reason said, and the draft is as it was', async () => {
		const { insert, menu, edit, said } = await setup(emptyBody(), { loaded: loaded(), selected: 's:s2' });
		const before = edit.body.value;
		// Not offered by the search, but a stale search might still ask.
		menu.open({ sock: null, at: { x: 1, y: 1 }, insert: { where: 'before', nodeId: 's:s2', what: 's2' } });
		await menu.choose(turning);
		expect(said.map((s) => s.text)).toEqual([BEFORE_RECORDED]);
		expect(insert.canInsert(undefined)).toBe(false);
		expect(edit.body.value.items.filter((i) => i.kind === 'operation')).toEqual([]);
		expect(edit.body.value.wires).toEqual(before.wires);
		// The sample was not added to the draft as a step of its own either: nothing to undo.
		expect(edit.body.value.items).toEqual([]);
		expect(edit.draft.canUndo.value).toBe(false);
	});

	it('after a done sample whose one outgoing wire is done: a new branch, the sample and the operation one undo step', async () => {
		const { insert, menu, edit, said } = await setup(emptyBody(), { loaded: loaded(), selected: 's:s1' });
		insert.openFor('after');
		await menu.choose(turning);
		expect(said).toEqual([]);
		expect(edit.body.value.items.map((i) => i.kind).sort()).toEqual(['operation', 'sample']);
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
		expect(edit.draft.canUndo.value).toBe(false);
	});

	it('a done operation is not offered Insert, and the key says why up front (no search opens)', async () => {
		const { insert, menu, said, graph, selectedId } = await setup(emptyBody(), { loaded: loaded(), selected: 'op:o1' });
		expect(insert.canInsert(graph.value.nodes.find((n) => n.id === 'op:o1'))).toBe(false);
		expect(insert.openFor('after')).toBe(true);
		selectedId.value = 'op:o1';
		expect(insert.openFor('before')).toBe(true);
		expect(said.map((s) => s.text)).toEqual([DONE_WIRE, DONE_WIRE]);
		expect(menu.target.value).toBeNull();
		// A done sample is still asked about (its "before" is refused, its "after" is not), and so is a new card.
		expect(insert.canInsert(graph.value.nodes.find((n) => n.id === 's:s2'))).toBe(true);
	});

	it('a card struck through as "will be deleted" is not offered Insert either', async () => {
		const data = mkData({ samples: [mkSample('s4', { status: 'planned' })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's4', version: 1 }] }, { type: 'remove', key: 'n1', deleteRecord: true }]);
		const { insert, said, graph } = await setup(body, { loaded: data, selected: 's:s4' });
		expect(insert.canInsert(graph.value.nodes.find((n) => n.id === 's:s4'))).toBe(false);
		expect(insert.openFor('after')).toBe(true);
		expect(said.map((s) => s.text)).toEqual([ALREADY_GOING]);
	});
});

describe('Dropping on a wire', () => {
	it('puts the operation between the two ends as one step, and says what is refused where the pointer is', async () => {
		const { insert, edit, said, wireOf } = await setup(chain());
		const w = wireOf('op:draft:n3', 's:draft:n4');
		expect(insert.wireVerdict(w, turning)).toBeNull();
		expect(insert.dropOnWire(w, turning, { x: 5, y: 6 }, { x: 50, y: 60 })).toBe(true);
		expect(edit.body.value.items.filter((i) => i.kind === 'operation')).toHaveLength(2);
		edit.undo();
		expect(edit.body.value.items).toHaveLength(3);
		// A test cannot go between two cards: refused with its reason, at the pointer.
		const test = { kind: 'test', testType: 'xrd' } as const;
		expect(insert.wireVerdict(w, test)).toMatchObject({ reason: expect.stringContaining('nothing coming out'), locked: false });
		expect(insert.dropOnWire(w, test, undefined, { x: 7, y: 8 })).toBe(false);
		expect(said).toEqual([{ text: expect.stringContaining('nothing coming out'), at: { x: 7, y: 8 } }]);
		expect(edit.body.value.items).toHaveLength(3);
	});

	it('a done wire is refused with the lock reason, and the verdict says it is a lock', async () => {
		const { insert, edit, said, wireOf } = await setup(emptyBody(), { loaded: loaded() });
		const w = wireOf('s:s1', 'op:o1');
		expect(insert.wireVerdict(w, turning)).toEqual({ reason: DONE_WIRE, locked: true });
		expect(insert.dropOnWire(w, turning, undefined, { x: 1, y: 2 })).toBe(false);
		expect(said[0]).toEqual({ text: DONE_WIRE, at: { x: 1, y: 2 } });
		expect(edit.body.value.items).toEqual([]);
	});
});
