import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref, type Ref } from 'vue';
import type { DraftBody, DraftRecord, HostApi } from '@d1/ui';
import type { MapNode } from '../model/types';
import { emptyBody } from './draft';
import { isEmptyBody, useEditMode, type EditModeOptions } from './useEditMode';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors: [{ message: `HTTP ${status}` }] } } });

/** d1-build in a box: drafts in memory, the reference data the Add menu reads, and a log of the calls. */
function fakeServer() {
	const drafts = new Map<string, DraftRecord>();
	const calls: string[] = [];
	const s = {
		drafts,
		calls,
		listStatus: 200,
		seed(id: string, body: DraftBody = emptyBody(), name = 'Seeded') {
			drafts.set(id, { id, name, body, version: 1, updated_at: '2026-10-14T10:00:00Z' });
		},
	};
	let n = 0;
	const idOf = (path: string) => decodeURIComponent(path.split('/')[3]);
	const api = {
		get: async (path: string) => {
			calls.push(`GET ${path}`);
			if (path === '/d1-build/drafts') {
				if (s.listStatus !== 200) throw httpError(s.listStatus);
				return { data: { data: [...drafts.values()].map((d) => ({ id: d.id, name: d.name, updated_at: d.updated_at, summary: 'x' })) } };
			}
			if (path.startsWith('/d1-build/drafts/')) {
				const d = drafts.get(idOf(path));
				if (!d) throw httpError(404);
				return { data: { data: d } };
			}
			if (path === '/items/manufacturing_methods') {
				return { data: { data: [{ method_id: 'm-turn', method_name: 'Turning', method_code: 'MC', process_category: 'machining' }] } };
			}
			return { data: { data: [] } };
		},
		post: async (path: string, body?: any) => {
			calls.push(`POST ${path}`);
			if (path === '/d1-build/drafts') {
				n += 1;
				const rec: DraftRecord = { id: `d${n}`, name: body.name, body: body.body, version: 1, updated_at: 'now' };
				drafts.set(rec.id, rec);
				return { data: { data: rec } };
			}
			if (path.endsWith('/check')) return { data: { data: { checks: [] } } };
			throw httpError(404);
		},
		patch: async (path: string, body?: any) => {
			calls.push(`PATCH ${path}`);
			const d = drafts.get(idOf(path));
			if (!d) throw httpError(404);
			const next: DraftRecord = { ...d, body: body.body ?? d.body, name: body.name ?? d.name, version: d.version + 1 };
			drafts.set(d.id, next);
			return { data: { data: next } };
		},
		delete: async (path: string) => {
			calls.push(`DELETE ${path}`);
			drafts.delete(idOf(path));
			return { data: {} };
		},
	} as unknown as HostApi;
	return { s, api };
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};

function setup(query: Record<string, string> = {}, extra: Partial<EditModeOptions> = {}, phone = false) {
	const server = fakeServer();
	const route = reactive({ path: '/map', query: { ...query } as Record<string, unknown> });
	const replace = vi.fn(async (to: { path: string; query: Record<string, string> }) => {
		route.query = to.query;
	});
	const isPhone: Ref<boolean> = ref(phone);
	const hint = vi.fn();
	const edit = useEditMode({
		api: server.api,
		fieldsFor: async () => [],
		route,
		router: { replace },
		isPhone,
		focus: () => {
			const f = typeof route.query.focus === 'string' ? route.query.focus : '';
			const [collection, id] = f.split(':');
			return f ? { collection, id } : null;
		},
		hint,
		...extra,
	});
	return { ...server, edit, route, replace, isPhone, hint };
}

describe('useEditMode: is it there', () => {
	it('is available once d1-build answers, and offers the toggle', async () => {
		const { edit } = setup();
		expect(edit.available.value).toBe(false);
		await flush();
		expect(edit.available.value).toBe(true);
		expect(edit.canBuild.value).toBe(true);
		expect(edit.editing.value).toBe(false);
	});

	it('hides everything when d1-build is absent (the probe 404s), and drops an `edit` from the address', async () => {
		const server = fakeServer();
		server.s.listStatus = 404;
		const route = reactive({ path: '/map', query: { edit: 'new' } as Record<string, unknown> });
		const replace = vi.fn(async (to: { query: Record<string, string> }) => void (route.query = to.query));
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace }, isPhone: ref(false), focus: () => null });
		await flush();
		expect(edit.available.value).toBe(false);
		expect(edit.canBuild.value).toBe(false);
		expect(edit.drafted.value).toBe(false);
		expect(route.query.edit).toBeUndefined();
		expect(edit.failed.value).toMatch(/not available/);
	});

	it('does not offer building on a phone (E20)', async () => {
		const { edit } = setup({}, {}, true);
		await flush();
		expect(edit.available.value).toBe(true);
		expect(edit.canBuild.value).toBe(false);
	});
});

describe('useEditMode: the address', () => {
	it('edit=new starts a draft and replaces the address with edit=<id>, keeping the other keys', async () => {
		const { edit, route, s } = setup({ edit: 'new', focus: 'physical_samples:s1', reach: '3' });
		expect(edit.pending.value).toBe(true);
		await flush();
		expect(s.calls.filter((c) => c === 'POST /d1-build/drafts')).toHaveLength(1);
		expect(route.query).toEqual({ edit: 'd1', focus: 'physical_samples:s1', reach: '3' });
		expect(edit.editing.value).toBe(true);
		expect(edit.pending.value).toBe(false);
	});

	it('names a new draft after the record being mapped and the date', async () => {
		const { s } = setup({ edit: 'new' }, { focusCode: () => 'S-1' });
		await flush();
		expect([...s.drafts.values()][0].name).toMatch(/^S-1 · \d{4}-\d{2}-\d{2}$/);
	});

	it('edit=<id> opens that draft', async () => {
		const server = fakeServer();
		server.s.seed('a', { ...emptyBody(), items: [{ key: 'n1', kind: 'sample', values: {} }], seq: 1 }, 'My cut');
		const route = reactive({ path: '/map', query: { edit: 'a' } as Record<string, unknown> });
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
		await flush();
		expect(edit.editing.value).toBe(true);
		expect(edit.draft.name.value).toBe('My cut');
		expect(edit.body.value.items).toHaveLength(1);
	});

	it('a draft that is not there says so and leaves edit mode', async () => {
		const { edit, route } = setup({ edit: 'missing' });
		await flush();
		expect(edit.drafted.value).toBe(false);
		expect(route.query.edit).toBeUndefined();
		expect(edit.failed.value).toBeTruthy();
	});

	it('on a phone a draft opens to look at, not to change (E20), and edit=new is dropped', async () => {
		const a = setup({ edit: 'new' }, {}, true);
		await flush();
		expect(a.route.query.edit).toBeUndefined();
		expect(a.s.calls).not.toContain('POST /d1-build/drafts');

		const server = fakeServer();
		server.s.seed('a');
		const route = reactive({ path: '/map', query: { edit: 'a' } as Record<string, unknown> });
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(true), focus: () => null });
		await flush();
		expect(edit.drafted.value).toBe(true);
		expect(edit.editing.value).toBe(false);
		edit.apply({ type: 'addSample' });
		expect(edit.body.value.items).toHaveLength(0);
	});

	it('startEditing asks for a new draft on the map being looked at', async () => {
		const { edit, route } = setup({ focus: 'physical_samples:s1' });
		await flush();
		edit.startEditing();
		expect(route.query).toEqual({ focus: 'physical_samples:s1', edit: 'new' });
		await flush();
		expect(route.query.edit).toBe('d1');
	});

	it('Open ▾ opens another draft and leaves the map record (a draft stands on its own cards)', async () => {
		const { edit, route, s } = setup({ edit: 'new', focus: 'physical_samples:s1' });
		await flush();
		s.seed('other');
		edit.openDraft('other');
		expect(route.query).toEqual({ edit: 'other' });
		await flush();
		expect(edit.draft.draftId.value).toBe('other');
	});
});

describe('useEditMode: leaving', () => {
	it('Done editing discards a draft with nothing in it and leaves the address', async () => {
		const { edit, route, s } = setup({ edit: 'new', focus: 'physical_samples:s1' });
		await flush();
		await edit.done();
		expect(s.drafts.size).toBe(0);
		expect(route.query).toEqual({ focus: 'physical_samples:s1' });
		await flush();
		expect(edit.drafted.value).toBe(false);
		expect(edit.draft.draftId.value).toBeNull();
	});

	it('Done editing keeps a draft with something in it, and lets go of it locally', async () => {
		const { edit, route, s } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' });
		expect(isEmptyBody(edit.body.value)).toBe(false);
		await edit.done();
		expect(s.drafts.size).toBe(1);
		expect([...s.drafts.values()][0].body.items).toHaveLength(1);
		expect(route.query.edit).toBeUndefined();
		await flush();
		expect(edit.draft.draftId.value).toBeNull();
	});

	it('the back button (the address loses `edit`) lets go of the draft too', async () => {
		const { edit, route } = setup({ edit: 'new' });
		await flush();
		route.query = {};
		await flush();
		expect(edit.drafted.value).toBe(false);
		expect(edit.draft.draftId.value).toBeNull();
	});
});

describe('useEditMode: changing the draft', () => {
	it('tells the canvas what kind of change it was, with the card it grew out of', async () => {
		const { edit, hint } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' }, { anchor: 's:x' });
		expect(hint).toHaveBeenCalledWith({ anchor: 's:x' });
		edit.apply({ type: 'addSample' });
		expect(hint).toHaveBeenLastCalledWith({ anchor: undefined });
		hint.mockClear();
		edit.undo();
		expect(hint).toHaveBeenCalledWith({});
		edit.apply({ type: 'setProject', projectId: null }); // changes nothing: no hint
		expect(hint).toHaveBeenCalledTimes(1);
	});

	it('an action that changes nothing tells nobody', async () => {
		const { edit, hint } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'remove', key: 'nope' });
		expect(hint).not.toHaveBeenCalled();
	});
});

describe('useEditMode: the draft on the map', () => {
	it('merges the draft into the loaded data, and keeps its cards drawn', async () => {
		const { edit } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample', values: { sample_code: '{seq}-Ti64-MF-2026-10-14' } });
		const merged = edit.overlay.merge(null);
		expect(merged.samples.map((s) => s.id)).toEqual(['draft:n1']);
		expect(merged.samples[0].draft).toBe(true);
		const card = { id: 's:draft:n1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'draft:n1', code: 'x' }, ins: [], outs: [] } satisfies MapNode;
		const other = { ...card, id: 's:old', ref: { ...card.ref, id: 'old' } } satisfies MapNode;
		expect(edit.overlay.keep(card)).toBe(true);
		expect(edit.overlay.keep(other)).toBe(false);
	});

	it('a blank canvas is a draft with no record to map', async () => {
		const a = setup({ edit: 'new' });
		await flush();
		expect(a.edit.overlay.active()).toBe(true);
		expect(a.edit.overlay.blank()).toBe(true);
		const b = setup({ edit: 'new', focus: 'physical_samples:s1' });
		await flush();
		expect(b.edit.overlay.blank()).toBe(false);
	});

	it('is not on the map outside edit mode', async () => {
		const { edit } = setup();
		await flush();
		expect(edit.overlay.active()).toBe(false);
		expect(edit.overlay.blank()).toBe(false);
	});

	it('knows which draft item is selected', async () => {
		let selected: MapNode | undefined;
		const { edit } = setup({ edit: 'new' }, { selected: () => selected });
		await flush();
		edit.apply({ type: 'addSample' });
		expect(edit.selectedKey.value).toBeNull();
		selected = { id: 's:draft:n1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'draft:n1', code: 'x' }, ins: [], outs: [] } as MapNode;
		// the selection is read afresh from the page's closure: a change of the draft makes it re-read
		edit.apply({ type: 'move', key: 'n1', x: 1, y: 2 });
		expect(edit.selectedKey.value).toBe('n1');
		expect(edit.selectedItem.value?.kind).toBe('sample');
	});

	it('reads the methods for the Add menu once edit mode is on', async () => {
		const { edit, s } = setup({ edit: 'new' });
		await flush();
		expect(edit.catalog.methods.value.map((m) => m.name)).toEqual(['Turning']);
		expect(s.calls.filter((c) => c === 'GET /items/manufacturing_methods')).toHaveLength(1);
	});
});
