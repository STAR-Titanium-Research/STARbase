import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { ContainerNode, MapNode } from '../model/types';
import { fakeServer, httpError, settle } from './fakeBuildServer';
import { markTargetOf, plannedTargetOf, useMarkDone } from './useMarkDone';
import { useEditMode } from './useEditMode';

const container = (over: Partial<ContainerNode> = {}): ContainerNode => ({
	id: 'op:o1',
	type: 'container',
	kind: 'operation',
	group: { id: 'op:o1', kind: 'operation', rowIds: ['o1'], batch: null },
	title: 'Turning',
	code: 'MC-1',
	category: 'machining',
	rows: [],
	slots: [],
	settings: [],
	bundled: false,
	probable: false,
	planned: true,
	...over,
});

describe('which card can be marked done', () => {
	it('a planned container of records, by its code', () => {
		expect(markTargetOf(container())).toEqual({ collection: 'manufacturing_operations', ids: ['o1'], title: 'Mark operation MC-1 done' });
	});
	it('a test goes to test_sessions', () => {
		const t = container({ kind: 'test', group: { id: 't', kind: 'test', rowIds: ['t1'], batch: null }, code: 'T-1' });
		expect(markTargetOf(t)).toMatchObject({ collection: 'test_sessions', ids: ['t1'], title: 'Mark test T-1 done' });
	});
	it('a batch or a stack is marked as a whole, by its title, every row together', () => {
		const stack = container({ stacked: true, title: '3 passes', group: { id: 's', kind: 'operation', rowIds: ['a', 'b', 'c'], batch: null, stack: true } });
		expect(markTargetOf(stack)).toMatchObject({ ids: ['a', 'b', 'c'], title: 'Mark operation 3 passes done' });
	});
	it('not what is done, a draft, still partly a draft, header only, or not a container', () => {
		expect(markTargetOf(container({ planned: undefined }))).toBeNull();
		expect(markTargetOf(container({ draft: true }))).toBeNull();
		expect(markTargetOf(container({ group: { id: 'x', kind: 'operation', rowIds: ['o1', 'draft:n3'], batch: null } }))).toBeNull();
		expect(markTargetOf(container({ collapsed: true }))).toBeNull();
		expect(markTargetOf({ type: 'record' })).toBeNull();
		expect(markTargetOf(undefined)).toBeNull();
	});
});

async function setup(selected: MapNode | undefined, available = true, extra: MapNode[] = []) {
	const server = fakeServer();
	if (!available) server.s.listStatus = 404;
	const route = reactive({ path: '/map', query: {} as Record<string, unknown> });
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
	await settle();
	await nextTick();
	const reload = vi.fn();
	const selectedId = ref<string | null>(selected?.id ?? null);
	const map = { graph: { value: { nodes: [...(selected ? [selected] : []), ...extra] } }, selectedId, reload } as never;
	return { ...server, md: useMarkDone({ edit, map }), reload, selectedId };
}

describe('Mark done', () => {
	it('is on offer for a planned card when d1-build is there, in view mode', async () => {
		expect((await setup(container())).md.canMarkDone.value).toBe(true);
		expect((await setup(container({ planned: undefined }))).md.canMarkDone.value).toBe(false);
		expect((await setup(undefined)).md.canMarkDone.value).toBe(false);
	});

	it('is not on offer when this server has no d1-build', async () => {
		expect((await setup(container(), false)).md.canMarkDone.value).toBe(false);
	});

	it('asks every row of the card at once, with the date and who, then reads the map again', async () => {
		const { md, s, reload } = await setup(container());
		md.show();
		expect(md.open.value).toBe(true);
		await md.confirm({ date: '2026-10-15', personId: 'p1' });
		expect(s.bodies).toEqual([{ collection: 'manufacturing_operations', ids: ['o1'], date: '2026-10-15', personId: 'p1' }]);
		expect(md.open.value).toBe(false);
		expect(reload).toHaveBeenCalled();
		expect(md.busy.value).toBe(false);
	});

	it('marks the card the dialog was opened for, even if another card is selected while it is open (E6)', async () => {
		const other = container({ id: 'op:o2', code: 'MC-2', group: { id: 'op:o2', kind: 'operation', rowIds: ['o2'], batch: null } });
		const { md, s, selectedId } = await setup(container(), true, [other]);
		md.show();
		selectedId.value = 'op:o2';
		expect(md.target.value?.ids).toEqual(['o1']);
		await md.confirm({ date: '2026-10-15', personId: null });
		expect(s.bodies).toEqual([{ collection: 'manufacturing_operations', ids: ['o1'], date: '2026-10-15' }]);
		expect(md.target.value?.ids).toEqual(['o2']); // closed: the rail's card again
	});

	it('leaves out the person when none was chosen (the server takes the caller\'s own)', async () => {
		const { md, s } = await setup(container());
		md.show();
		await md.confirm({ date: '2026-10-15', personId: null });
		expect(s.bodies[0]).toEqual({ collection: 'manufacturing_operations', ids: ['o1'], date: '2026-10-15' });
	});

	it('a refusal by Checks stays in the dialog, with the checks to show', async () => {
		const { md, s, reload } = await setup(container());
		const checks = [{ key: 'o1', level: 'block', text: 'Fill in Spindle speed: a done operation needs it.' }];
		s.markAnswer = httpError(409, { code: 'CHECKS', checks });
		md.show();
		await md.confirm({ date: '2026-10-15', personId: null });
		expect(md.open.value).toBe(true);
		expect(md.checks.value).toEqual(checks);
		expect(reload).not.toHaveBeenCalled();
	});

	it('another refusal closes the dialog and says why', async () => {
		const { md, s } = await setup(container());
		s.markAnswer = httpError(403);
		md.show();
		await md.confirm({ date: '2026-10-15', personId: null });
		expect(md.open.value).toBe(false);
		expect(md.error.value).toBe('HTTP 403');
	});

	it('cancel closes, and does nothing without a card', async () => {
		const { md } = await setup(container());
		md.show();
		md.cancel();
		expect(md.open.value).toBe(false);
		const none = await setup(undefined);
		none.md.show();
		expect(none.md.open.value).toBe(false);
		await none.md.confirm({ date: '2026-10-15', personId: null });
		expect(none.s.bodies).toEqual([]);
	});

	it('is not asked twice while it runs', async () => {
		const { md, s } = await setup(container());
		md.show();
		await Promise.all([md.confirm({ date: '2026-10-15', personId: null }), md.confirm({ date: '2026-10-15', personId: null })]);
		expect(s.bodies).toHaveLength(1);
	});
});

describe('which card can be set back to planned', () => {
	const done = (over: Partial<ContainerNode> = {}) => container({ planned: undefined, ...over });
	it('a done container of records, by its code', () => {
		expect(plannedTargetOf(done())).toEqual({ collection: 'manufacturing_operations', ids: ['o1'], title: 'Set operation MC-1 back to planned' });
	});
	it('a done test goes to test_sessions, a stack or batch as a whole', () => {
		expect(plannedTargetOf(done({ kind: 'test', group: { id: 't', kind: 'test', rowIds: ['t1'], batch: null }, code: 'T-1' }))).toMatchObject({ collection: 'test_sessions', ids: ['t1'] });
		const stack = done({ stacked: true, title: '3 passes', group: { id: 's', kind: 'operation', rowIds: ['a', 'b', 'c'], batch: null, stack: true } });
		expect(plannedTargetOf(stack)).toMatchObject({ ids: ['a', 'b', 'c'], title: 'Set operation 3 passes back to planned' });
	});
	it('not what is planned already, a draft, partly a draft, header only, or not a container', () => {
		expect(plannedTargetOf(container())).toBeNull();
		expect(plannedTargetOf(done({ draft: true }))).toBeNull();
		expect(plannedTargetOf(done({ group: { id: 'x', kind: 'operation', rowIds: ['o1', 'draft:n3'], batch: null } }))).toBeNull();
		expect(plannedTargetOf(done({ collapsed: true }))).toBeNull();
		expect(plannedTargetOf({ type: 'record' })).toBeNull();
		expect(plannedTargetOf(undefined)).toBeNull();
	});
});

describe('Back to planned', () => {
	const doneCard = () => container({ planned: undefined });

	it('is on offer for a done card when d1-build is there, and not for a planned one', async () => {
		expect((await setup(doneCard())).md.canMarkPlanned.value).toBe(true);
		expect((await setup(container())).md.canMarkPlanned.value).toBe(false);
		expect((await setup(doneCard(), false)).md.canMarkPlanned.value).toBe(false);
		expect((await setup(undefined)).md.canMarkPlanned.value).toBe(false);
	});

	it('sets every row back at once and reads the map again', async () => {
		const { md, s, reload } = await setup(doneCard());
		await md.markPlanned();
		expect(s.bodies).toEqual([{ collection: 'manufacturing_operations', ids: ['o1'] }]);
		expect(reload).toHaveBeenCalled();
		expect(md.error.value).toBe('');
		expect(md.settingBack.value).toBe(false);
	});

	it('the server refusing (not the owner) is said, and the map is left as it was', async () => {
		const { md, s, reload } = await setup(doneCard());
		s.plannedAnswer = Object.assign(new Error('HTTP 403'), { response: { status: 403, data: { errors: [{ message: 'Only the owner can set a done record back to planned.' }] } } });
		await md.markPlanned();
		expect(md.error.value).toBe('Only the owner can set a done record back to planned.');
		expect(reload).not.toHaveBeenCalled();
	});

	it('is not asked twice while it runs, and does nothing for a planned card', async () => {
		const { md, s } = await setup(doneCard());
		await Promise.all([md.markPlanned(), md.markPlanned()]);
		expect(s.bodies).toHaveLength(1);
		const planned = await setup(container());
		await planned.md.markPlanned();
		expect(planned.s.bodies).toEqual([]);
	});
});
