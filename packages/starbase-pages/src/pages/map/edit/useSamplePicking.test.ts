import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { PickedRow } from '@d1/ui';
import { fakeServer, settle } from './fakeBuildServer';
import { useEditMode } from './useEditMode';
import { useSamplePicking } from './useSamplePicking';

// The picker's confirm and the fly-in, in a node environment: the cards on the screen are small stand-ins that record their animations.

interface Played {
	id: string;
	delay: number | undefined;
	ghost: boolean;
}

function setup() {
	const played: Played[] = [];
	const elements = new Map<string, unknown>();
	const cardFor = (id: string, ghost = false) => ({
		animate: (_k: Keyframe[], o: KeyframeAnimationOptions) => {
			played.push({ id, delay: o.delay as number | undefined, ghost });
			return { finished: Promise.resolve() } as unknown as Animation;
		},
		getBoundingClientRect: () => ({ left: 800, top: 100, width: 220, height: 100 }),
		remove: vi.fn(),
	});
	for (const id of ['s1', 's2']) elements.set(`s:${id}`, cardFor(id));
	const nodeEls = () => [...elements].map(([dataset, card]) => ({ dataset: { id: dataset }, querySelector: () => card }));
	const canvasEl = ref({ querySelectorAll: () => nodeEls(), getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }) } as unknown as HTMLElement);
	vi.stubGlobal('document', {
		// A ghost says the code of its sample, which is how the test tells which one flew.
		createElement: () => {
			const g = {
				style: {},
				textContent: '',
				remove: vi.fn(),
				animate: (_k: Keyframe[], o: KeyframeAnimationOptions) => {
					played.push({ id: g.textContent, delay: o.delay as number | undefined, ghost: true });
					return { finished: Promise.resolve() } as unknown as Animation;
				},
			};
			return g;
		},
		body: { appendChild: () => undefined },
	});
	return { played, canvasEl, cardFor };
}

afterEach(() => void vi.unstubAllGlobals());

async function start() {
	const server = fakeServer();
	server.s.seed('d');
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
	await settle();
	await nextTick();
	const dom = setup();
	const nodes = ref<unknown[]>([]);
	const picking = useSamplePicking({
		edit,
		map: { nodes } as never,
		canvas: { toFlow: (x: number, y: number) => ({ x: x - 100, y: y - 50 }), whenSettled: async () => true },
		canvasEl: dom.canvasEl,
	});
	return { edit, picking, nodes, ...dom };
}

const row = (id: string, rect: PickedRow['rect'] = { left: 100, top: 400, width: 110, height: 40, right: 210, bottom: 440, x: 100, y: 400, toJSON() {} } as DOMRect): PickedRow => ({ id, code: id, rect });

describe('picking samples', () => {
	it('adds them as a column at the top left of the canvas, in one step with the project it takes from the first', async () => {
		const { edit, picking } = await start();
		await picking.picked([row('s1'), row('s2')]);
		expect(edit.body.value.items.map((i) => i.existing)).toEqual([{ id: 's1', version: 4 }, { id: 's2', version: 2 }]);
		expect(edit.body.value.positions).toEqual({ n1: { x: 80, y: 80 }, n2: { x: 80, y: 220 } });
		expect(edit.body.value.projectId).toBe('proj1');
		edit.undo();
		expect(edit.body.value.items).toHaveLength(0);
		expect(edit.body.value.projectId).toBeNull();
	});

	it('closes the picker, and flies the cards in, 40 ms apart', async () => {
		const { picking, played } = await start();
		picking.open.value = true;
		await picking.picked([row('s1'), row('s2')]);
		expect(picking.open.value).toBe(false);
		expect(played.map((p) => [p.id, p.delay, p.ghost])).toEqual([['s1', 0, false], ['s2', 40, false]]);
	});

	it('says so when some cannot be read, and adds the rest', async () => {
		const { edit, picking } = await start();
		await picking.picked([row('s1'), row('ghost')]);
		expect(edit.body.value.items).toHaveLength(1);
		expect(picking.problem.value).toMatch(/Some of the samples could not be read/);
		const none = await start();
		await none.picking.picked([row('ghost')]);
		expect(none.picking.problem.value).toMatch(/none was added/);
		expect(none.edit.body.value.items).toHaveLength(0);
	});

	it('does nothing for no rows', async () => {
		const { edit, picking } = await start();
		await picking.picked([]);
		expect(edit.body.value.items).toHaveLength(0);
	});

	it('lists the samples already drawn so the picker will not take them twice (not the draft\'s new ones)', async () => {
		const { picking, nodes } = await start();
		nodes.value = [
			{ type: 'record', kind: 'sample', ref: { id: 's9' } },
			{ type: 'record', kind: 'sample', ref: { id: 'draft:n1' } },
			{ type: 'record', kind: 'material', ref: { id: 'm1' } },
			{ type: 'container', kind: 'operation' },
		];
		expect(picking.taken.value).toEqual(['s9']);
	});
});

describe('undo and redo of a pick', () => {
	it('undo takes the whole pick away and plays it backwards with ghosts of the cards', async () => {
		const { edit, picking, played } = await start();
		await picking.picked([row('s1'), row('s2')]);
		played.length = 0;
		picking.undo();
		expect(edit.body.value.items).toHaveLength(0);
		await settle();
		expect(played.map((p) => [p.id, p.delay, p.ghost])).toEqual([['PS-001', 0, true], ['PS-002', 40, true]]);
	});

	it('redo brings it back and plays it forwards again', async () => {
		const { edit, picking, played } = await start();
		await picking.picked([row('s1'), row('s2')]);
		picking.undo();
		played.length = 0;
		picking.redo();
		expect(edit.body.value.items).toHaveLength(2);
		await settle();
		expect(played.map((p) => [p.id, p.ghost])).toEqual([['s1', false], ['s2', false]]);
	});

	it('another change is undone without any fly', async () => {
		const { edit, picking, played } = await start();
		edit.apply({ type: 'addSample' });
		played.length = 0;
		picking.undo();
		await settle();
		expect(edit.body.value.items).toHaveLength(0);
		expect(played).toEqual([]);
	});
});
