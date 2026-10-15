import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { MapNode, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import { useEditMode } from './useEditMode';
import { useEditSurface } from './useEditSurface';

// What the keys do to the selected draft item, and Connect to…, with the page's pieces faked.

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const card = (id: string): RecordNode => ({ id: `s:${id}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: id }, ins: [], outs: [] });

async function setup(body: DraftBody, selectedId: string | null) {
	const server = fakeServer();
	server.s.seed('d', body);
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	let selected: MapNode | undefined = selectedId ? card(selectedId) : undefined;
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null, selected: () => selected });
	await settle();
	await nextTick();
	const surface = useEditSurface({
		edit,
		map: { graph: { value: { nodes: [] } }, nodes: ref([]), clearHover() {} } as never,
		canvas: { toFlow: (x: number, y: number) => ({ x, y }), remeasure: async () => undefined, whenSettled: async () => true } as never,
		canvasEl: ref(null),
	});
	return { edit, surface, select: (id: string | null) => void (selected = id ? card(id) : undefined) };
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
