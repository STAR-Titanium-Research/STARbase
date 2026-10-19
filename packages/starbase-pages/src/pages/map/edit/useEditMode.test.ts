import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref, type Ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { MapNode } from '../model/types';
import { apply, emptyBody } from './draft';
import { fakeServer, httpError } from './fakeBuildServer';
import { FORBIDDEN, NOT_KEPT, PHONE_NEW, UNAVAILABLE, isEmptyBody, isNotice, useEditMode, type EditModeOptions } from './useEditMode';

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
		expect(edit.failed.value).toBe(UNAVAILABLE);
	});

	it('an account that may not build (the probe is 403): no toggle, an `edit` in the address is dropped, and a plain notice instead of an error', async () => {
		const server = fakeServer();
		server.s.listStatus = 403;
		const route = reactive({ path: '/map', query: { edit: 'new' } as Record<string, unknown> });
		const replace = vi.fn(async (to: { query: Record<string, string> }) => void (route.query = to.query));
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace }, isPhone: ref(false), focus: () => null });
		await flush();
		expect(edit.available.value).toBe(false);
		expect(edit.canBuild.value).toBe(false);
		expect(edit.drafted.value).toBe(false);
		expect(edit.pending.value).toBe(false);
		expect(route.query.edit).toBeUndefined();
		expect(edit.failed.value).toBe(FORBIDDEN);
		expect(edit.failed.value).toBe('Your account may not build processes.');
		expect(isNotice(edit.failed.value)).toBe(true);
		expect(isNotice(UNAVAILABLE)).toBe(true);
		expect(isNotice('Could not reach the server.')).toBe(false);
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
		await edit.openDraft('other');
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

describe('useEditMode: what is not kept is not lost', () => {
	it('Done editing stays in edit mode, and says so, when the last changes could not be saved', async () => {
		const { edit, route, s } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' });
		s.patchStatus = -1;
		await edit.done();
		expect(route.query.edit).toBeDefined();
		expect(edit.editing.value).toBe(true);
		expect(edit.failed.value).toBe(NOT_KEPT);
		expect(edit.body.value.items).toHaveLength(1);
		// The connection is back: the next Done editing goes through, and the message was cleared as the save went.
		s.patchStatus = 0;
		await edit.done();
		expect(route.query.edit).toBeUndefined();
		expect(edit.failed.value).toBe('');
		expect([...s.drafts.values()][0].body.items).toHaveLength(1);
	});

	it('opening another draft waits for the save, and stays when it fails', async () => {
		const { edit, route, s } = setup({ edit: 'new' });
		await flush();
		s.seed('other');
		edit.apply({ type: 'addSample' });
		s.patchStatus = 500;
		await edit.openDraft('other');
		expect(route.query.edit).not.toBe('other');
		expect(edit.failed.value).toBe(NOT_KEPT);
		s.patchStatus = 0;
		await edit.openDraft('other');
		expect(route.query.edit).toBe('other');
	});

	it('the back button keeps a draft whose changes the server does not have, instead of dropping it', async () => {
		const { edit, route, s } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' });
		s.patchStatus = -1;
		route.query = {};
		await flush();
		expect(edit.draft.draftId.value).not.toBeNull();
		expect(edit.failed.value).toBe(NOT_KEPT);
	});

	it('the back button discards a draft with nothing in it', async () => {
		const { edit, route, s } = setup({ edit: 'new' });
		await flush();
		route.query = {};
		await flush();
		expect(s.drafts.size).toBe(0);
		expect(edit.draft.draftId.value).toBeNull();
	});

	it('a draft whose start is overtaken by the address moving on is not left behind', async () => {
		const server = fakeServer();
		let open!: () => void;
		server.s.postGate = new Promise<void>((r) => (open = r));
		const route = reactive({ path: '/map', query: { edit: 'new' } as Record<string, unknown> });
		const replace = vi.fn(async (to: { query: Record<string, string> }) => void (route.query = to.query));
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace }, isPhone: ref(false), focus: () => null });
		await flush();
		route.query = {};
		await flush();
		open();
		await flush();
		expect(server.s.drafts.size).toBe(0);
		expect(edit.draft.draftId.value).toBeNull();
		expect(route.query.edit).toBeUndefined();
	});
});

describe('useEditMode: why edit mode did not open', () => {
	it('says why on a phone instead of dropping edit=new without a word', async () => {
		const { edit, route } = setup({ edit: 'new' }, {}, true);
		await flush();
		expect(route.query.edit).toBeUndefined();
		expect(edit.failed.value).toBe(PHONE_NEW);
	});

	it('a probe that fails (not a 404) says why, keeps the toggle, and asks again on the next try', async () => {
		const server = fakeServer();
		server.s.listStatus = 500;
		const route = reactive({ path: '/map', query: { edit: 'new' } as Record<string, unknown> });
		const replace = vi.fn(async (to: { query: Record<string, string> }) => void (route.query = to.query));
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace }, isPhone: ref(false), focus: () => null });
		await flush();
		expect(edit.available.value).toBe(false);
		expect(edit.failed.value).not.toBe(UNAVAILABLE);
		expect(edit.failed.value).toMatch(/HTTP 500|Could not/);
		expect(edit.canBuild.value).toBe(true);
		// The server is back: the toggle works without reloading the page.
		server.s.listStatus = 200;
		edit.startEditing();
		await flush();
		expect(edit.editing.value).toBe(true);
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

describe('useEditMode: typing in a form', () => {
	it('folds the changes of one item\'s values into one undo step, until something else changes', async () => {
		const { edit } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' });
		edit.setValues('n1', { form: 'd' });
		edit.setValues('n1', { form: 'di' });
		edit.setValues('n1', { form: 'disc' });
		edit.undo();
		expect(edit.body.value.items[0].values.form).toBeUndefined();
		// another item, or another kind of change, starts a new step
		edit.redo();
		edit.apply({ type: 'addSample' });
		edit.setValues('n2', { form: 'a' });
		edit.apply({ type: 'move', key: 'n1', x: 1, y: 1 });
		edit.setValues('n2', { form: 'ab' });
		edit.undo();
		expect(edit.body.value.items[1].values.form).toBe('a');
	});
});

describe('useEditMode: typing in two fields of one item', () => {
	it('is one undo step per field, as useDraft documents', async () => {
		const { edit } = setup({ edit: 'new' });
		await flush();
		edit.apply({ type: 'addSample' });
		edit.setValues('n1', { form: 'd' });
		edit.setValues('n1', { form: 'disc' });
		edit.setValues('n1', { notes: 'a' });
		edit.setValues('n1', { notes: 'ab' });
		edit.undo(); // the notes
		expect(edit.body.value.items[0].values.notes).toBeUndefined();
		expect(edit.body.value.items[0].values.form).toBe('disc');
		edit.undo(); // the form
		expect(edit.body.value.items[0].values.form).toBeUndefined();
	});
});

describe('useEditMode: reading what the draft holds', () => {
	it('does not ask again for a sample that could not be read, on every change of the draft', async () => {
		const server = fakeServer();
		const body = [{ type: 'addExistingSamples' as const, samples: [{ id: 'nope', version: 1 }] }].reduce((b, a) => apply(b, a), emptyBody());
		server.s.seed('d', body);
		const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
		const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
		await flush();
		const asks = () => server.s.calls.filter((c) => c === 'GET /items/physical_samples').length;
		const first = asks();
		expect(first).toBe(1);
		for (let i = 0; i < 3; i++) {
			edit.apply({ type: 'addSample' });
			await flush();
		}
		expect(asks()).toBe(first);
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

	it('reads the methods for the add search once edit mode is on', async () => {
		const { edit, s } = setup({ edit: 'new' });
		await flush();
		expect(edit.catalog.methods.value.map((m) => m.name)).toEqual(['FAST sintering', 'Heat treatment', 'Turning']);
		expect(s.calls.filter((c) => c === 'GET /items/manufacturing_methods')).toHaveLength(1);
	});
});
