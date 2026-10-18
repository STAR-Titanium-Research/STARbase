import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import type { MenuTarget } from './menuTarget';
import { useAddMenu } from './useAddMenu';
import { useEditCanvas } from './useEditCanvas';
import { useEditMode } from './useEditMode';

async function setup(editing = true, body?: DraftBody) {
	const server = fakeServer();
	server.s.seed('d', body);
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(!editing), focus: () => null });
	await settle();
	await nextTick();
	const rect = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 };
	const canvasEl = ref({ getBoundingClientRect: () => rect, querySelectorAll: () => [] } as unknown as HTMLElement);
	const canvas = { toFlow: (x: number, y: number) => ({ x: x - 100, y: y - 50 }), remeasure: async () => undefined };
	const picked = vi.fn();
	const ec = useEditCanvas({ edit, map: { graph: { value: { nodes: [] } }, clearHover() {} } as never, canvas: canvas as never, canvasEl, openMenu: () => undefined });
	const connect = vi.fn();
	const menu = useAddMenu({ edit, canvas, canvasEl, ensureSample: ec.ensureSample, pickSamples: picked, connect });
	return { edit, menu, picked, connect };
}

describe('the Add menu\'s state', () => {
	it('opens unconnected at a point on the canvas, and places a card there in the map\'s own coordinates', async () => {
		const { menu } = await setup();
		menu.open({ sock: null, at: { x: 300, y: 200 } });
		expect(menu.target.value).toMatchObject({ at: { x: 300, y: 200 }, flow: { x: 200, y: 150 } });
	});

	it('opened from outside the canvas (the lid\'s Add), the card goes in the middle of it', async () => {
		const { menu } = await setup();
		menu.open({ sock: null, at: { x: 300, y: 20 } });
		expect(menu.target.value?.flow).toEqual({ x: 400, y: 300 });
	});

	it('leaves a socket\'s card to the layout (it lines up with the socket\'s card)', async () => {
		const { menu } = await setup();
		menu.open({ sock: { kind: 'sample', id: 'x', side: 'out' }, at: { x: 300, y: 200 }, anchor: 'card' });
		expect(menu.target.value?.flow).toBeUndefined();
	});

	it('does not open when the draft cannot be changed', async () => {
		const { menu } = await setup(false);
		menu.open({ sock: null, at: { x: 1, y: 1 } });
		expect(menu.target.value).toBeNull();
	});

	it('a choice does its actions as one step, places the card, closes the menu', async () => {
		const { menu, edit } = await setup();
		menu.open({ sock: null, at: { x: 300, y: 200 } });
		await menu.choose({ kind: 'operation', methodId: 'm-turn', category: 'machining' });
		expect(menu.target.value).toBeNull();
		expect(edit.body.value.items).toHaveLength(1);
		expect(edit.body.value.positions.n1).toEqual({ x: 200, y: 150 });
		edit.undo();
		expect(edit.body.value.items).toHaveLength(0);
	});

	it('Pick samples opens the picker instead', async () => {
		const { menu, picked, edit } = await setup();
		menu.open({ sock: null, at: { x: 300, y: 200 } });
		await menu.choose({ kind: 'pickSamples' });
		expect(picked).toHaveBeenCalled();
		expect(edit.body.value.items).toHaveLength(0);
	});

	it('Connect to… opens the list for the socket the menu was on', async () => {
		const { menu, connect } = await setup();
		const t: MenuTarget = { sock: { kind: 'sample', id: 'draft:n1', side: 'out' }, at: { x: 1, y: 1 }, anchor: 'card' };
		menu.open(t);
		await menu.choose({ kind: 'connectTo' });
		expect(connect).toHaveBeenCalledWith(t);
		expect(menu.target.value).toBeNull();
	});

	it('a sample found in the database is added to the draft with its version, then wired to the socket', async () => {
		const { menu, edit } = await setup();
		edit.apply({ type: 'addContainer', kind: 'operation', source: { from: 'blank' } });
		const t: MenuTarget = { sock: { kind: 'row', id: 'draft:n2', side: 'in' }, at: { x: 300, y: 200 } };
		menu.open(t);
		await menu.choose({ kind: 'record', id: 's1', code: 'PS-001' });
		const sample = edit.body.value.items.find((i) => i.kind === 'sample');
		expect(sample?.existing).toEqual({ id: 's1', version: 4 });
		expect(edit.body.value.wires).toEqual([{ from: { key: sample!.key }, to: { key: 'n1', row: 0 } }]);
		// The sample and its wire are one undo step.
		edit.undo();
		expect(edit.body.value.items.map((i) => i.kind)).toEqual(['operation']);
		expect(edit.body.value.wires).toEqual([]);
	});

	it('a menu choice on a sample of the loaded history is one undo step with the sample it adds', async () => {
		const { menu, edit } = await setup();
		menu.open({ sock: { kind: 'sample', id: 's1', side: 'out' }, at: { x: 300, y: 200 }, anchor: 'card' });
		await menu.choose({ kind: 'operation', methodId: 'm-turn', category: 'machining' });
		expect(edit.body.value.items.map((i) => i.kind).sort()).toEqual(['operation', 'sample']);
		edit.undo();
		expect(edit.body.value.items).toHaveLength(0);
	});

	it('a choice made after the menu closed does nothing', async () => {
		const { menu, edit } = await setup();
		await menu.choose({ kind: 'newSample' });
		expect(edit.body.value.items).toHaveLength(0);
	});
});

describe('the Add menu on a free socket that adds a row (R5)', () => {
	const run = (actions: DraftAction[]): DraftBody => actions.reduce((b, a) => apply(b, a), emptyBody());
	const body = () =>
		run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);

	it('a new sample from it adds the piece and the sample as one step; undo takes both', async () => {
		const { menu, edit } = await setup(true, body());
		menu.open({ sock: { kind: 'row', id: 'draft:n3', side: 'out', add: true }, at: { x: 300, y: 200 }, anchor: 'card' });
		await menu.choose({ kind: 'newSample' });
		const op = edit.body.value.items.find((i) => i.key === 'n2');
		expect(op?.kind === 'operation' && op.rows).toHaveLength(2);
		const made = edit.body.value.items.filter((i) => i.kind === 'sample');
		expect(made).toHaveLength(3);
		expect(edit.body.value.wires).toContainEqual({ from: { key: 'n2', row: 1 }, to: { key: made[2].key } });
		edit.undo();
		const back = edit.body.value.items.find((i) => i.key === 'n2');
		expect(back?.kind === 'operation' && back.rows).toHaveLength(1);
		expect(edit.body.value.items.filter((i) => i.kind === 'sample')).toHaveLength(2);
	});

	it('a sample from the free input is wired to a new row of its own', async () => {
		const { menu, edit } = await setup(true, body());
		menu.open({ sock: { kind: 'row', id: 'draft:n3', side: 'in', add: true }, at: { x: 300, y: 200 }, anchor: 'card' });
		await menu.choose({ kind: 'newSample' });
		const op = edit.body.value.items.find((i) => i.key === 'n2');
		expect(op?.kind === 'operation' && op.rows).toHaveLength(2);
		expect(edit.body.value.wires.filter((w) => w.to.key === 'n2').map((w) => w.to.row)).toEqual([0, 1]);
	});

	it('does nothing when the card cannot take a row', async () => {
		const rec = run([{ type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 1 }, workState: 'planned' }]);
		const { menu, edit } = await setup(true, rec);
		menu.open({ sock: { kind: 'row', id: 'op-1', side: 'out', add: true }, at: { x: 1, y: 1 } });
		await menu.choose({ kind: 'newSample' });
		expect(edit.body.value).toBe(rec);
	});
});
