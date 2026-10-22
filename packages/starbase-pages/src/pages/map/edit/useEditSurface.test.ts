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
import { useTemplates } from './useTemplates';

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
	// What the page does to show a new card: select it (without centring) and pan to it only when it is out of view.
	const mapSelect = vi.fn();
	const reveal = vi.fn();
	const surface = useEditSurface({
		edit,
		templates: useTemplates({ api: server.api, gear: edit.catalog.gear, me: () => ({}) }),
		map: { graph, selectedId: pick, select: mapSelect, data: { value: over.loaded ?? null }, inHistory: (id: string) => !!over.loaded?.samples.some((s) => s.id === id), nodes: computed(() => graph.value.nodes), clearHover() {} } as never,
		canvas: { toFlow: (x: number, y: number) => ({ x, y }), remeasure: async () => undefined, whenSettled: async () => true, reveal } as never,
		canvasEl: ref(over.canvasEl ?? null),
		blockedBy: over.blockedBy,
	});
	return { edit, surface, server, graph, mapSelect, reveal, pickNode: (id: string | null) => void (pick.value = id), select: (id: string | null) => void ((selected = id ? card(id) : undefined), (pick.value = id ? `s:${id}` : null)) };
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

	it('a wire end dragged off its input takes that one wire, as one step; a free socket, an output, or a socket nothing ends on has none to take', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const { edit, surface, graph } = await setup(body, null);
		const into = graph.value.wires.find((w) => w.to.startsWith('op:draft:n3'))!;
		const rowIn = { kind: 'row', id: 'draft:n3', side: 'in' } as const;
		expect(surface.dropWireAt(rowIn, null), 'a free socket (a button, no socket id)').toBe(false);
		expect(surface.dropWireAt({ kind: 'sample', id: 'draft:n1', side: 'out' }, into.from), 'an output').toBe(false);
		expect(surface.dropWireAt(rowIn, 'op:draft:n3:in:99'), 'a socket nothing is drawn on').toBe(false);
		expect(edit.body.value.wires).toHaveLength(1);
		expect(surface.dropWireAt(rowIn, into.to)).toBe(true);
		expect(edit.body.value.wires).toEqual([]);
		expect(surface.dropWireAt(rowIn, into.to), 'nothing left to take').toBe(false);
		edit.undo();
		expect(edit.body.value.wires).toHaveLength(1);
	});

	it('an input with two wires (a test of two samples) loses neither to a drag: the wire is picked by clicking it, and the reason is said', async () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } },
		]);
		const withSecond = run([{ type: 'wire', from: { key: 'n2' }, to: { key: 'n3' } }], body);
		const { edit, surface, graph } = await setup(withSecond, null);
		const into = graph.value.wires.filter((w) => w.to.startsWith('test:draft:n3'));
		expect(into).toHaveLength(2);
		const testIn = { kind: 'row', id: 'draft:n3', side: 'in' } as const;
		expect(surface.dropWireAt(testIn, into[0].to)).toBe(true); // handled: the menu does not open
		expect(edit.body.value.wires, 'neither wire went').toHaveLength(2);
		expect(surface.problem.value).toMatch(/2 wires/);
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

describe('the palette\'s Enter (R1)', () => {
	const turning = { id: 'op:mt', section: 'Machining', label: 'Turning', choice: { kind: 'operation', methodId: 'mt', category: 'machining' } } as const;

	it('adds the entry at the middle of the canvas when nothing is selected, as one undo step', async () => {
		const { edit, surface } = await setup(emptyBody(), null);
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items.map((i) => i.kind)).toEqual(['operation']);
		expect(edit.body.value.items[0].values.method_id).toBe('mt');
		expect(edit.body.value.positions.n1).toEqual({ x: 0, y: 0 });
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
	});

	it('adds it next to the selected card (no place of its own: the layout puts it beside the card, clear of every other)', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample' }]), 'draft:n1');
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items).toHaveLength(2);
		expect(edit.body.value.positions.n2).toBeUndefined();
	});

	it('wires an operation to the new sample that is selected, in the same step', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample' }]), 'draft:n1');
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }]);
		edit.undo();
		expect(edit.body.value.items.map((i) => i.key), 'one undo takes back the card and its wire').toEqual(['n1']);
		expect(edit.body.value.wires).toEqual([]);
	});

	it('wires it to the last new sample with a free output when another card is selected', async () => {
		const { edit, surface } = await setup(run([{ type: 'addSample' }, { type: 'addSample' }]), null);
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n2' }, to: { key: 'n3', row: 0 } }]);
	});

	it('leaves it floating next to a selected sample of the history: that sample is no new input', async () => {
		const { edit, surface } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]), 's1');
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items).toHaveLength(2);
		expect(edit.body.value.wires, 'floating: nothing is wired').toEqual([]);
	});

	it('one click adds once: a second click on the same entry a moment later is the same click', async () => {
		const { edit, surface } = await setup(emptyBody(), null);
		surface.paletteAdd(turning);
		await settle();
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items).toHaveLength(1);
		edit.undo();
		expect(edit.body.value.items, 'one undo step').toEqual([]);
	});

	it('an add that added nothing is not "the click": a retry of the same entry at once still adds', async () => {
		const { edit, surface } = await setup(emptyBody(), null);
		surface.paletteAdd({ ...turning, choice: { kind: 'sameSample' } });
		await settle();
		expect(edit.body.value.items).toEqual([]);
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items).toHaveLength(1);
	});

	it('a different entry, or the same one after the window, adds another', async () => {
		const { edit, surface } = await setup(emptyBody(), null);
		const now = vi.spyOn(Date, 'now');
		now.mockReturnValue(1000);
		surface.paletteAdd(turning);
		now.mockReturnValue(1200);
		surface.paletteAdd({ ...turning, id: 'op:other' });
		now.mockReturnValue(1800);
		surface.paletteAdd(turning);
		await settle();
		now.mockRestore();
		expect(edit.body.value.items).toHaveLength(3);
	});

	it('selects the new card without centring and pans to it only if it is out of view', async () => {
		const { surface, mapSelect, reveal } = await setup(emptyBody(), null);
		surface.paletteAdd(turning);
		await settle();
		expect(mapSelect).toHaveBeenCalledTimes(1);
		expect(mapSelect.mock.calls[0], 'no { centre: true }').toHaveLength(1);
		expect(mapSelect.mock.calls[0][0]).toMatch(/^op:draft:/);
		expect(reveal).toHaveBeenCalledWith(mapSelect.mock.calls[0][0]);
	});

	it('a choice in the add search with no socket does the same: wired to the sample just added, then shown', async () => {
		const { edit, surface, mapSelect, reveal } = await setup(run([{ type: 'addSample' }]), null);
		surface.addUnconnected({ x: 300, y: 200 });
		await surface.menu.choose(turning.choice);
		await settle();
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }]);
		expect(mapSelect).toHaveBeenCalledWith(expect.stringMatching(/^op:draft:/));
		expect(reveal).toHaveBeenCalledTimes(1);
		edit.undo();
		expect(edit.body.value.items.map((i) => i.key), 'one step').toEqual(['n1']);
	});

	it('selects a new sample by its own card', async () => {
		const { surface, mapSelect } = await setup(emptyBody(), null);
		surface.paletteAdd({ id: 'sample:new', section: 'Samples', label: 'New sample', choice: { kind: 'newSample' } });
		await settle();
		expect(mapSelect).toHaveBeenCalledWith('s:draft:n1');
	});

	it('puts the keyboard on the new card kind choice, else its first empty field; a card with neither is fine', async () => {
		// A canvas with one card and what is in it: the card the page selected (its id is read when the page looks for it).
		let picked: { mock: { calls: unknown[][] } } | undefined;
		const canvasOf = (inside: { kind?: HTMLElement; fields: readonly HTMLElement[] }) => {
			const card = { dataset: { get id() { return picked?.mock.calls[0]?.[0]; } }, querySelector: (q: string) => (q === '[data-kind-select]' ? (inside.kind ?? null) : null), querySelectorAll: () => inside.fields };
			return { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), querySelectorAll: () => [card] } as unknown as HTMLElement;
		};
		const field = (value: string) => ({ value, focus: vi.fn() }) as unknown as HTMLInputElement;
		const [filled, empty, kind] = [field('x'), field(''), field('')];
		for (const [inside, focused] of [
			[{ kind, fields: [filled, empty] }, kind],
			[{ fields: [filled, empty] }, empty],
			[{ fields: [] }, null],
		] as const) {
			const { surface, mapSelect } = await setup(emptyBody(), null, { canvasEl: canvasOf(inside) });
			picked = mapSelect;
			surface.paletteAdd(turning);
			await settle();
			await nextTick();
			for (const f of [kind, empty, filled]) expect(f.focus).toHaveBeenCalledTimes(f === focused ? 1 : 0);
			vi.clearAllMocks();
		}
	});

	it('Existing sample… opens the picker', async () => {
		const { surface } = await setup(emptyBody(), null);
		surface.paletteAdd({ id: 'sample:pick', section: 'Samples', label: 'Existing sample…', choice: { kind: 'pickSamples' } });
		expect(surface.pickerOpen.value).toBe(true);
	});

	it('does nothing when the draft cannot be changed', async () => {
		const { edit, surface } = await setup(emptyBody(), null);
		edit.draft.forget();
		surface.paletteAdd(turning);
		await settle();
		expect(edit.body.value.items).toEqual([]);
	});
});

describe('the add search at the keyboard and insert', () => {
	it('Shift+A with no focus opens the unconnected search at the pointer', async () => {
		const { surface } = await setup(emptyBody(), null);
		surface.addUnconnected({ x: 300, y: 200 });
		expect(surface.menu.target.value).toMatchObject({ sock: null, at: { x: 300, y: 200 } });
	});

	it('insert before the selected card opens the search as an insert; nothing selected leaves the key to the browser', async () => {
		const { surface, select } = await setup(run([{ type: 'addSample' }]), 'draft:n1');
		expect(surface.insertSelected('after')).toBe(true);
		expect(surface.menu.target.value?.insert).toMatchObject({ where: 'after', nodeId: 's:draft:n1' });
		surface.menu.close();
		select(null);
		expect(surface.insertSelected('before')).toBe(false);
		expect(surface.menu.target.value).toBeNull();
	});

	it('an open insert search blocks the other keys', async () => {
		const { surface } = await setup(run([{ type: 'addSample' }]), 'draft:n1');
		surface.insertSelected('after');
		expect(surface.blocked.value).toBe(true);
	});
});

describe('From database… (slice 3)', () => {
	const orphan = (id: string, over: Record<string, unknown> = {}) => ({
		operation_id: id, pass_code: `CODE-${id}`, operation_sequence: 1, operation_date: null, planned_date: '2026-11-01', work_state: 'planned', version: 5, sample_id: null,
		method_id: { method_id: 'm-turn', method_name: 'Turning' }, owner_person_id: { full_name: 'Ada' }, output_sample_id: 's2', ...over,
	});
	const at = { x: 300, y: 200 };
	const loaded = () => mkData({ samples: [mkSample('s1'), mkSample('sp', { status: 'planned' })] });
	const open = async (over: { rows?: Record<string, unknown>[]; sample?: string | null; body?: DraftBody } = {}) => {
		const r = await setup(over.body ?? emptyBody(), null, { loaded: loaded() });
		r.server.s.rows.manufacturing_operations = over.rows ?? [orphan('a'), orphan('b', { work_state: 'done', operation_date: '2026-09-01', planned_date: null })];
		const sample = over.sample === undefined ? 's1' : over.sample;
		await r.surface.menu.applyAt({ sock: sample === null ? null : { kind: 'sample', id: sample, side: 'out' }, at, anchor: 's:s1' }, { kind: 'fromDatabase' });
		return r;
	};

	it('opens the picker for the socket, and lists the operations with no input sample', async () => {
		const { surface, edit } = await open();
		expect(surface.attaching.target.value).toMatchObject({ sock: { kind: 'sample', id: 's1', side: 'out' } });
		expect(surface.attachHeading.value).toBe('Attach to S1');
		expect(surface.blocked.value).toBe(true);
		expect(edit.body.value.items).toEqual([]);
		const found = await surface.attaching.search('');
		expect(found.rows.map((r) => r.id)).toEqual(['a', 'b']);
		expect(found.rows.every((r) => surface.attaching.reasonOf(r) === null)).toBe(true);
	});

	it('a pick attaches it to the sample (which joins the draft) at the version read now, as ONE undo step; the operation shows on the canvas wired', async () => {
		const { surface, edit, graph } = await open();
		const row = (await surface.attaching.search('')).rows[0];
		await surface.attaching.pick(row);
		expect(surface.attaching.target.value).toBeNull();
		const op = edit.body.value.items.find((i) => i.kind === 'operation');
		expect(op).toMatchObject({ existing: { id: 'a', version: 5 }, attach: true, workState: 'planned' });
		const sample = edit.body.value.items.find((i) => i.kind === 'sample');
		expect(sample?.existing?.id).toBe('s1');
		expect(edit.body.value.wires).toEqual([{ from: { key: sample!.key }, to: { key: op!.key, row: 0 } }]);
		await settle();
		expect(graph.value.nodes.some((n) => n.id === 'op:a')).toBe(true);
		expect(graph.value.wires.some((w) => w.from === 's:s1:out:0' && w.to === 'op:a:in:0')).toBe(true);
		expect(edit.summary.value).toMatch(/attach 1 operation/i);
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
		edit.redo();
		expect(edit.body.value.items).toHaveLength(2);
	});

	it('an operation attached already is greyed with the reason; a second pick of it does nothing', async () => {
		const { surface, edit } = await open();
		const rows = (await surface.attaching.search('')).rows;
		await surface.attaching.pick(rows[0]);
		await surface.menu.applyAt({ sock: { kind: 'sample', id: 's1', side: 'out' }, at, anchor: 's:s1' }, { kind: 'fromDatabase' });
		expect(surface.attaching.reasonOf(rows[0])).toBe('Already attached in this draft.');
		expect(surface.attaching.reasonOf(rows[1])).toBeNull();
		await surface.attaching.pick(rows[0]);
		expect(surface.attaching.problem.value).toBe('Already attached in this draft.');
		expect(edit.body.value.items.filter((i) => i.kind === 'operation')).toHaveLength(1);
	});

	it('done work cannot be attached to a sample that is still planned (greyed with the server\'s words), planned work can', async () => {
		const { surface } = await open({ sample: 'sp' });
		const rows = (await surface.attaching.search('')).rows;
		expect(surface.attaching.reasonOf(rows[0])).toBeNull(); // planned
		expect(surface.attaching.reasonOf(rows[1])).toBe('Its sample is still planned; mark the operation that makes it done first.'); // done
	});

	it('an operation that got an input since the list was read is refused at the pick, nothing is attached', async () => {
		const { surface, edit, server } = await open();
		const row = (await surface.attaching.search('')).rows[0];
		server.s.rows.manufacturing_operations = [orphan('a', { sample_id: 's2', version: 6 })];
		await surface.attaching.pick(row);
		expect(surface.attaching.problem.value).toMatch(/got an input in the meantime/);
		expect(surface.attaching.target.value, 'the picker stays open to choose another').not.toBeNull();
		expect(edit.body.value.items).toEqual([]);
	});

	it('an operation the caller can see but not change is refused at the pick, in words; when that cannot be asked the pick goes on (Create asks the database)', async () => {
		const { surface, edit, server } = await open();
		const row = (await surface.attaching.search('')).rows[0];
		server.s.readOnly = ['a'];
		await surface.attaching.pick(row);
		expect(surface.attaching.problem.value).toBe('You can see this operation but not change it.');
		expect(surface.attaching.target.value, 'the picker stays open').not.toBeNull();
		expect(edit.body.value.items).toEqual([]);
		server.s.readOnly = [];
		server.s.permissionError = true;
		await surface.attaching.pick(row);
		expect(edit.body.value.items.some((i) => i.kind === 'operation' && i.attach)).toBe(true);
	});

	it('an operation that is gone, or that the caller cannot read, is refused at the pick', async () => {
		const { surface, edit, server } = await open();
		const row = (await surface.attaching.search('')).rows[0];
		server.s.rows.manufacturing_operations = [];
		await surface.attaching.pick(row);
		expect(surface.attaching.problem.value).toMatch(/gone, or you can no longer see it/);
		expect(edit.body.value.items).toEqual([]);
	});

	it('opened unconnected (the palette), the pick lands floating: attached to nothing yet, which Create refuses with a visible check', async () => {
		const { surface, edit } = await open({ sample: null });
		const row = (await surface.attaching.search('')).rows[0];
		await surface.attaching.pick(row);
		expect(edit.body.value.items).toHaveLength(1);
		expect(edit.body.value.wires).toEqual([]);
		await settle();
		expect(edit.checks.value.some((c) => c.level === 'block' && /needs a sample/.test(c.text))).toBe(true);
	});

	it('the palette entry opens the picker, floating, beside the selected card', async () => {
		const { surface } = await setup(emptyBody(), null);
		surface.paletteAdd({ id: 'db:attach', section: 'From the database', label: 'From database…', choice: { kind: 'fromDatabase' } });
		await settle();
		expect(surface.attaching.target.value).toMatchObject({ sock: null });
		expect(surface.attachHeading.value).toBe('Add to the canvas');
	});

	it('keeps the card it was opened from after it closes, so focus can go back to it', async () => {
		const { surface } = await open();
		expect(surface.attaching.anchor.value).toBe('s:s1');
		const row = (await surface.attaching.search('')).rows[0];
		await surface.attaching.pick(row);
		expect(surface.attaching.target.value).toBeNull();
		expect(surface.attaching.anchor.value).toBe('s:s1');
	});

	it('closing the picker changes nothing', async () => {
		const { surface, edit } = await open();
		surface.attaching.close();
		expect(surface.attaching.target.value).toBeNull();
		expect(edit.body.value.items).toEqual([]);
	});
});
