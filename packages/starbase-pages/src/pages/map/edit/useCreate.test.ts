import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { fakeServer, httpError, settle } from './fakeBuildServer';
import { TOAST_MS, useCreate } from './useCreate';
import { useEditMode } from './useEditMode';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

async function setup(focus: string | null = null) {
	const server = fakeServer();
	server.s.seed('d', run([{ type: 'addSample', values: { sample_code: '{seq}-Ti64-MC-2026-10-15', material_id: 'm', primary_method_id: 'p' } }]));
	const route = reactive({ path: '/map', query: { edit: 'd', ...(focus ? { focus } : {}) } as Record<string, unknown> });
	const replace = vi.fn(async (to: { query: Record<string, string> }) => void (route.query = to.query));
	const edit = useEditMode({
		api: server.api,
		fieldsFor: async () => [],
		route,
		router: { replace },
		isPhone: ref(false),
		focus: () => (typeof route.query.focus === 'string' ? { collection: 'physical_samples', id: route.query.focus.split(':')[1] } : null),
	});
	await settle();
	await nextTick();
	const reload = vi.fn();
	const select = vi.fn();
	const map = { focus: { value: focus ? { collection: 'physical_samples', id: focus.split(':')[1] } : null }, reload } as never;
	return { ...server, edit, route, replace, reload, select, create: useCreate({ edit, map, select }) };
}

describe('Create', () => {
	it('leaves edit mode, focuses the first new sample, and shows the toast', async () => {
		const { create, route, reload } = await setup();
		await create.create();
		expect(route.query).toEqual({ focus: 'physical_samples:new1' });
		expect(create.toast.value).toEqual({ sampleIds: ['new1'], count: 1 });
		expect(create.error.value).toBe('');
		expect(reload).not.toHaveBeenCalled(); // the new focus loads the map by itself
	});

	it('reads this map again when the focus does not change, or no sample was made', async () => {
		const same = await setup('physical_samples:new1');
		await same.create.create();
		expect(same.reload).toHaveBeenCalled();
		const none = await setup('physical_samples:old');
		none.s.createAnswer = { data: { created: { n2: { collection: 'manufacturing_operations', id: 'op9', code: null } }, sampleIds: [] } };
		await none.create.create();
		expect(none.route.query).toEqual({ focus: 'physical_samples:old' });
		expect(none.reload).toHaveBeenCalled();
		expect(none.create.toast.value?.count).toBe(1);
	});

	it('counts distinct created records, not the keys the server files them under (an operation is under its row key and its item key)', async () => {
		const { create, s } = await setup();
		const op = { collection: 'manufacturing_operations', id: 'op1', code: null };
		s.createAnswer = {
			data: {
				created: {
					n1: { collection: 'physical_samples', id: 'new1', code: null },
					n2: op,
					n3: op,
				},
				sampleIds: ['new1'],
			},
		};
		await create.create();
		expect(create.toast.value?.count).toBe(2);
	});

	it('the toast goes away when it is closed', async () => {
		const { create } = await setup();
		await create.create();
		create.closeToast();
		expect(create.toast.value).toBeNull();
	});

	it('the toast goes away by itself after a while', async () => {
		const { create } = await setup();
		vi.useFakeTimers();
		try {
			await create.create();
			expect(create.toast.value).not.toBeNull();
			await vi.advanceTimersByTimeAsync(TOAST_MS - 1);
			expect(create.toast.value).not.toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			expect(create.toast.value).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('a refusal by Checks leaves the draft, says why and marks what is missing', async () => {
		const { create, s, route, edit } = await setup();
		s.createAnswer = httpError(409, { code: 'CHECKS', checks: [{ key: 'n1', level: 'block', text: 'Choose the material.', code: 'REQUIRED' }] });
		await create.create();
		expect(create.error.value).toBe('HTTP 409');
		expect(create.showMissing.value).toBe(true);
		expect(create.toast.value).toBeNull();
		expect(route.query.edit).toBe('d');
		expect(edit.body.value.items).toHaveLength(1);
	});

	it('a record that could not be written selects the card it came from', async () => {
		const { create, s, select } = await setup();
		s.createAnswer = httpError(500, { code: 'WRITE_FAILED', key: 'n1' });
		await create.create();
		expect(select).toHaveBeenCalledWith('n1');
		expect(create.showMissing.value).toBe(false);
	});

	it('says it when the server cannot be reached, and tries again from a clean slate', async () => {
		const { create, s } = await setup();
		s.createAnswer = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
		await create.create();
		expect(create.error.value).toMatch(/Could not reach the server/);
		s.createAnswer = { data: { created: { n1: { collection: 'physical_samples', id: 'new1', code: null } }, sampleIds: ['new1'] } };
		await create.create();
		expect(create.error.value).toBe('');
		expect(create.toast.value).not.toBeNull();
	});

	it('a caller with no researcher row is told why, and the draft is kept (nothing created, no toast, edit mode stays open)', async () => {
		const { create, s, route, edit } = await setup();
		const message = "Your account isn't linked to a researcher record. Ask an admin.";
		s.createAnswer = Object.assign(new Error('HTTP 422'), { response: { status: 422, data: { errors: [{ message, extensions: { code: 'NO_RESEARCHER' } }] } } });
		await create.create();
		expect(create.error.value).toBe(message);
		expect(create.showMissing.value).toBe(false);
		expect(create.toast.value).toBeNull();
		expect(route.query.edit).toBe('d');
		expect(edit.body.value.items).toHaveLength(1);
		expect(edit.draft.draftId.value).toBe('d');
	});

	it('knows an empty draft', async () => {
		const { create, edit } = await setup();
		expect(create.empty.value).toBe(false);
		edit.apply({ type: 'remove', key: 'n1' });
		expect(create.empty.value).toBe(true);
	});

	it('a draft of only picked existing samples would make nothing', async () => {
		const { create, edit } = await setup();
		edit.apply([{ type: 'remove', key: 'n1' }, { type: 'addExistingSamples', samples: [{ id: 's9', version: 1 }] }]);
		expect(edit.body.value.items).toHaveLength(1);
		expect(create.empty.value).toBe(true);
		edit.apply({ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n2' } });
		expect(create.empty.value).toBe(false);
	});
});
