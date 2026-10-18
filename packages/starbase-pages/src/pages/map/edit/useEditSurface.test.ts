import { describe, expect, it, vi } from 'vitest';
import { computed, nextTick, reactive, ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import type { MapNode, ProcessData, RecordNode } from '../model/types';
import { toGraph } from './toGraph';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import { useEditMode } from './useEditMode';
import { useEditSurface } from './useEditSurface';

// What the keys do to the selected draft item, and Connect to…, with the page's pieces faked.

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const card = (id: string): RecordNode => ({ id: `s:${id}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: id }, ins: [], outs: [] });

async function setup(body: DraftBody, selectedId: string | null, over: { canvasEl?: HTMLElement | null; blockedBy?: () => boolean; loaded?: ProcessData } = {}) {
	const server = fakeServer();
	server.s.seed('d', body);
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	let selected: MapNode | undefined = selectedId ? card(selectedId) : undefined;
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null, selected: () => selected });
	await settle();
	await nextTick();
	// The map as the page has it: the loaded data, and the graph it draws with the draft merged in.
	const pick = ref<string | null>(selectedId ? `s:${selectedId}` : null);
	const graph = computed(() => {
		const d = toGraph(over.loaded ?? null, edit.body.value);
		return buildGraph(d, groupBatches(d.operations, d.tests, { probable: false, stack: true }), { slots: () => [] });
	});
	const surface = useEditSurface({
		edit,
		map: { graph, selectedId: pick, data: { value: over.loaded ?? null }, nodes: computed(() => graph.value.nodes), clearHover() {} } as never,
		canvas: { toFlow: (x: number, y: number) => ({ x, y }), remeasure: async () => undefined, whenSettled: async () => true } as never,
		canvasEl: ref(over.canvasEl ?? null),
		blockedBy: over.blockedBy,
	});
	return { edit, surface, server, graph, pickNode: (id: string | null) => void (pick.value = id), select: (id: string | null) => void ((selected = id ? card(id) : undefined), (pick.value = id ? `s:${id}` : null)) };
}

describe('Delete', () => {
	it('takes the selected draft item off the canvas, with its wires', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		const { edit, surface } = await setup(body, 'draft:n1');
		expect(surface.removeSelected()).toBe(true);
		expect(edit.body.value.items.map((i) => i.key)).toEqual(['n2']);
		expect(edit.body.value.wires).toEqual([]);
		edit.undo();
		expect(edit.body.value.items).toHaveLength(2);
	});

	it('puts keyboard focus back on the map: the card that had it is gone', async () => {
		const focus = vi.fn();
		const canvasEl = { querySelectorAll: () => [], hasAttribute: () => true, setAttribute: () => undefined, focus } as unknown as HTMLElement;
		const { surface } = await setup(run([{ type: 'addSample' }]), 'draft:n1', { canvasEl });
		surface.removeSelected();
		await nextTick();
		await nextTick();
		expect(focus).toHaveBeenCalled();
	});

	it('does nothing when nothing in the draft is selected (a card of the loaded history is not)', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample' }]), 'old-sample');
		expect(surface.removeSelected()).toBe(false);
		expect(edit.body.value.items).toHaveLength(1);
	});

	it('forgets an existing sample without deleting the record', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		expect(surface.removeSelected()).toBe(true);
		expect(edit.body.value.items).toEqual([]);
	});
});

describe('Delete on the canvas (R4)', () => {
	const loaded = (): ProcessData =>
		mkData({
			samples: [mkSample('s1', { status: 'active' }), mkSample('s2', { status: 'active' }), mkSample('s3', { status: 'planned' })],
			operations: [
				mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', date: '2026-09-01T09:00:00Z' }),
				mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', methodName: 'Cut', workState: 'planned' }),
			],
		});

	it('a done record is not removed: the reason is said and the draft is as it was', async () => {
		const { edit, surface, pickNode } = await setup(emptyBody(), null, { loaded: loaded() });
		pickNode('s:s1');
		const before = edit.body.value;
		expect(surface.removeSelected()).toBe(true);
		await settle();
		expect(edit.body.value).toBe(before);
		expect(surface.problem.value).toBe("Done records can't be removed from the map");
		pickNode('op:o1');
		surface.problem.value = '';
		surface.removeSelected();
		expect(surface.problem.value).toBe("Done records can't be removed from the map");
	});

	it('a planned record that exists is read, added to the draft and marked for deletion, as one undoable step', async () => {
		const { edit, surface, server, pickNode } = await setup(emptyBody(), null, { loaded: loaded() });
		server.s.rows = { manufacturing_operations: [{ operation_id: 'o2', version: 5, work_state: 'planned' }] };
		pickNode('op:o2');
		expect(surface.removeSelected()).toBe(true);
		await settle();
		expect(edit.body.value.items).toHaveLength(1);
		expect(edit.body.value.items[0]).toMatchObject({ kind: 'operation', existing: { id: 'o2', version: 5 }, remove: true });
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
		edit.redo();
		expect(edit.body.value.items[0]).toMatchObject({ remove: true });
	});

	it('a planned record that cannot be read is not deleted, and the person is told', async () => {
		const { edit, surface, pickNode } = await setup(emptyBody(), null, { loaded: loaded() });
		pickNode('op:o2');
		surface.removeSelected();
		await settle();
		expect(edit.body.value.items).toEqual([]);
		expect(surface.problem.value).toMatch(/could not be read/);
	});

	it('Delete takes the selected wire when one is picked, and not the card that is selected too', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const { edit, surface, graph, pickNode } = await setup(body, null);
		pickNode('s:draft:n1');
		const wire = graph.value.wires[0];
		surface.mapEdit.selectWire(wire.id);
		expect(surface.mapEdit.selectedWire.value).toBe(wire.id);
		expect(surface.removeSelected()).toBe(true);
		expect(edit.body.value.wires).toEqual([]);
		expect(edit.body.value.items).toHaveLength(2);
		expect(surface.mapEdit.selectedWire.value).toBeNull();
		edit.undo();
		expect(edit.body.value.wires).toHaveLength(1);
	});

	it('picking another card drops the wire selection', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const { surface, graph, pickNode } = await setup(body, null);
		surface.mapEdit.selectWire(graph.value.wires[0].id);
		pickNode('s:draft:n1');
		await nextTick();
		expect(surface.mapEdit.selectedWire.value).toBeNull();
	});

	it('a click on the empty canvas, or Escape, lets go of the wire; a click on a card or a wire does not', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const { surface, graph } = await setup(body, null);
		const id = graph.value.wires[0].id;
		const click = (closest: string | null) => ({ target: { closest: () => (closest ? {} : null) } }) as unknown as MouseEvent;
		surface.mapEdit.selectWire(id);
		surface.onCanvasClick(click('.vue-flow__node'));
		expect(surface.mapEdit.selectedWire.value).toBe(id);
		surface.onCanvasClick(click(null));
		expect(surface.mapEdit.selectedWire.value).toBeNull();
		surface.mapEdit.selectWire(id);
		surface.mapEdit.selectWire(id); // a second click on the wire lets go of it
		expect(surface.mapEdit.selectedWire.value).toBeNull();
	});

	it('a wire end dragged off its input and dropped on empty canvas takes the draft\'s wire, as one step; an output or a free input has none to take', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const { edit, surface } = await setup(body, null);
		expect(surface.dropWireAt({ kind: 'sample', id: 'draft:n1', side: 'out' })).toBe(false);
		expect(surface.dropWireAt({ kind: 'sample', id: 'draft:n1', side: 'in' })).toBe(false);
		expect(surface.dropWireAt({ kind: 'row', id: 'draft:n3', side: 'in' })).toBe(true);
		expect(edit.body.value.wires).toEqual([]);
		expect(surface.dropWireAt({ kind: 'row', id: 'draft:n3', side: 'in' })).toBe(false);
		edit.undo();
		expect(edit.body.value.wires).toHaveLength(1);
	});

	it('the locks the cards wear: a done record says why, a card of the draft has none', async () => {
		const body = run([{ type: 'addSample' }]);
		const { surface, graph } = await setup(body, null, { loaded: loaded() });
		const node = (id: string) => graph.value.nodes.find((n) => n.id === id)!;
		expect(surface.mapEdit.lockOf(node('s:s1'))).toBe("Done records can't be removed from the map");
		expect(surface.mapEdit.lockOf(node('op:o2'))).toBeNull();
		expect(surface.mapEdit.lockOf(node('s:draft:n1'))).toBeNull();
		const done = graph.value.wires.find((w) => w.to.startsWith('s:s2'))!;
		expect(surface.mapEdit.wireLock(done.id)).toBe("Done records' wires can't be removed from the map");
	});

	it('Dissolve joins the input to the output and is one undoable step', async () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'cut' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'pol' }, from: { key: 'n4' } },
		]);
		const { edit, surface, pickNode } = await setup(body, null);
		pickNode('op:draft:n3');
		expect(surface.canDissolve.value).toBe(true);
		expect(surface.dissolveSelected()).toBe(true);
		expect(edit.body.value.items.map((i) => i.key)).toEqual(['n1', 'n5']);
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n1' }, to: { key: 'n5', row: 0 } }]);
		edit.undo();
		expect(edit.body.value.items.map((i) => i.key)).toEqual(['n1', 'n2', 'n4', 'n5']);
	});

	it('Dissolve of something it cannot dissolve says why and changes nothing', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows: 2, from: { key: 'n1' } }]);
		const { edit, surface, graph, pickNode } = await setup(body, null);
		pickNode(graph.value.nodes.find((n) => n.type === 'container')!.id);
		const before = edit.body.value;
		expect(surface.dissolveSelected()).toBe(true);
		expect(edit.body.value).toBe(before);
		expect(surface.problem.value).toMatch(/2 outputs/);
		pickNode(null);
		expect(surface.dissolveSelected()).toBe(false);
	});
});

describe('what keeps the edit keys quiet', () => {
	it('is anything else the page has open over the map (the Mark done dialog, the Finder)', async () => {
		const other = ref(false);
		const { surface } = await setup(run([]), null, { blockedBy: () => other.value });
		expect(surface.blocked.value).toBe(false);
		other.value = true;
		expect(surface.blocked.value).toBe(true);
	});
});

describe('Duplicate', () => {
	it('copies the selected new item, n times', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample', values: { form: 'disc' } }]), 'draft:n1');
		expect(surface.duplicateSelected(1)).toBe(true);
		expect(edit.body.value.items).toHaveLength(2);
		surface.duplicateSelected(3);
		expect(edit.body.value.items).toHaveLength(5);
		expect(edit.body.value.items.every((i) => i.kind === 'sample' && i.values.form === 'disc')).toBe(true);
	});

	it('copies an existing sample as a new one with the same details, once its record is read', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		await settle();
		surface.duplicateSelected(1);
		const copy = edit.body.value.items[1];
		expect(copy.existing).toBeUndefined();
		expect(copy.values.form).toBe('disc');
		expect(copy.values.sample_code).toBeUndefined(); // the code is made at Create
	});

	it('copies only what a new record may carry: the row read with * also has short_id, code_sort, restricted and alias arrays', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		await settle();
		edit.catalog.records.set('physical_samples:s1', {
			version: 4,
			values: { sample_id: 's1', sample_code: 'PS-001', short_id: 'ab12cd', code_sort: 'x', restricted: false, form: 'disc', co_owners: [{ user_id: 'u' }], current_status: 'active', material_id: 'mat1' },
		});
		surface.duplicateSelected(1);
		const copy = edit.body.value.items[1];
		expect(Object.keys(copy.values).sort()).toEqual(['form', 'material_id']);
	});

	it('a copy of a team-owned sample is the copier\'s: the owner fields are not carried (Create would refuse them)', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		await settle();
		edit.catalog.records.set('physical_samples:s1', { version: 4, values: { sample_id: 's1', form: 'disc', owner_person_id: 'p1', owner_team_id: 't1' } });
		surface.duplicateSelected(1);
		expect(edit.body.value.items[1].values).toEqual({ form: 'disc' });
	});

	it('says so when the record of an existing item is not read yet, and copies nothing', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		edit.catalog.records.clear();
		expect(surface.duplicateSelected(1)).toBe(true);
		expect(edit.body.value.items).toHaveLength(1);
		expect(surface.problem.value).toMatch(/still being read/);
	});

	it('does nothing with nothing selected', async () => {
		const { surface } = await setup(run([{ type: 'addSample' }]), null);
		expect(surface.duplicateSelected(2)).toBe(false);
	});

	it('Shift+Ctrl+D asks how many, then makes that many', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample' }]), 'draft:n1');
		expect(surface.duplicating.value).toBeNull();
		// the key handler calls askDuplicate through useEditKeys; its prompt is the surface's `duplicating`
		surface.duplicating.value = { what: 'this sample' };
		surface.confirmDuplicate(4);
		expect(surface.duplicating.value).toBeNull();
		expect(edit.body.value.items).toHaveLength(5);
	});
});

describe('Connect to…', () => {
	const body = () => run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm-turn' } }]);

	it('lists the sockets a socket can be wired to, named, and wires the one chosen', async () => {
		const { edit, surface } = await setup(body(), null);
		surface.connecting.value = { sock: { kind: 'sample', id: 'draft:n1', side: 'out' }, at: { x: 0, y: 0 }, anchor: 'card' };
		await settle();
		const entries = surface.connectEntries.value;
		expect(entries.map((e) => e.label)).toEqual(['Turning']);
		expect(surface.connectFrom.value).toBe('New sample');
		await surface.connectTo(entries[0]);
		expect(surface.connecting.value).toBeNull();
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }]);
	});

	it('closes without a wire when what was chosen no longer fits', async () => {
		const { edit, surface } = await setup(body(), null);
		surface.connecting.value = { sock: { kind: 'sample', id: 'draft:n1', side: 'out' }, at: { x: 0, y: 0 } };
		const [entry] = surface.connectEntries.value;
		edit.apply({ type: 'wire', from: { key: 'n1' }, to: { key: 'n2', row: 0 } });
		await surface.connectTo(entry);
		expect(edit.body.value.wires).toHaveLength(1);
	});
});

describe('blocking the keys', () => {
	it('while the list, the prompt, a menu or the picker is open', async () => {
		const { surface } = await setup(emptyBody(), null);
		expect(surface.blocked.value).toBe(false);
		surface.pickerOpen.value = true;
		expect(surface.blocked.value).toBe(true);
		surface.pickerOpen.value = false;
		surface.duplicating.value = { what: 'x' };
		expect(surface.blocked.value).toBe(true);
	});
});
