import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createFakeInbox, foundFile, type FakeInboxOptions } from './fakeInboxServer';
import type { Notice } from './useInbox';
import { createIgnoredFolders } from './useIgnoredFolders';

const TEAM = { kind: 'team', id: '00000000-0000-4000-8000-000000000021', name: 'SEM team' } as const;
const files = () => [
	foundFile({ rel_path: 'Users/ab1cd/Paper/Drafts/a.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/Paper/b.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/root.tif' }),
	foundFile({ rel_path: 'Shared/SEM/Old runs/d.tif', owner: TEAM }),
];

function setup(opts: FakeInboxOptions = {}, api?: (base: HostApi) => HostApi) {
	const fake = createFakeInbox({ files: files(), ...opts });
	const notes: Array<Notice | null> = [];
	const onChanged = vi.fn(async () => undefined);
	const ig = createIgnoredFolders({ api: api ? api(fake.api) : fake.api, say: (n) => notes.push(n), rows: () => fake.files, onChanged });
	return { fake, ig, notes, onChanged, last: () => notes.at(-1) };
}

describe('createIgnoredFolders', () => {
	it('load reads the rules; a server with no such route is "not available", any other failure keeps the list and says why', async () => {
		const { ig } = setup({ ignoredRules: [{ folder: 'x' }] });
		await ig.load();
		expect(ig.rules.value.map((r) => r.folder)).toEqual(['x']);
		expect(ig.loading.value).toBe(false);
		expect(ig.available.value).toBe(true);

		const old = setup({}, (b) => ({ ...b, get: () => Promise.reject(Object.assign(new Error('nope'), { response: { status: 404, data: { errors: [{ message: 'Route /d1-inbox/ignored-folders doesn\'t exist.', extensions: { code: 'ROUTE_NOT_FOUND' } }] } } })) }));
		await old.ig.load();
		expect(old.ig.available.value).toBe(false);
		expect(old.ig.error.value).toBe('');

		let down = false;
		const flaky = setup({ ignoredRules: [{ folder: 'x' }] }, (b) => ({ ...b, get: (p, c) => (down ? Promise.reject(Object.assign(new Error('boom'), { response: { status: 500, data: { errors: [{ message: 'The database is busy.' }] } } })) : b.get(p, c)) }));
		await flaky.ig.load();
		down = true;
		await flaky.ig.load();
		expect(flaky.ig.error.value).toBe('The database is busy.');
		expect(flaky.ig.rules.value.map((r) => r.folder)).toEqual(['x']);
		expect(flaky.ig.available.value).toBe(true);
	});

	it('openIgnore opens the confirm with the folder and an estimate; a file in the root opens nothing', () => {
		const { ig, fake } = setup();
		ig.openIgnore(fake.files[2]);
		expect(ig.dialog.value.open).toBe(false);
		ig.openIgnore(fake.files[0]);
		expect(ig.dialog.value).toMatchObject({ open: true, target: { folder: 'Paper/Drafts', teamId: null }, shown: 1, busy: false, error: '' });
		ig.closeIgnore();
		expect(ig.dialog.value.open).toBe(false);
		ig.openIgnore(fake.files[3]);
		expect(ig.dialog.value.target).toMatchObject({ folder: 'Old runs', teamId: TEAM.id, ownerKind: 'team' });
	});

	it('confirmIgnore adds the rule, says the server\'s count with a Remove rule button, reloads the lists and closes', async () => {
		const { ig, fake, last, onChanged } = setup();
		ig.openIgnore(fake.files[1]);
		expect(ig.dialog.value.target?.folder).toBe('Paper');
		const r = await ig.confirmIgnore();
		expect(r).toEqual({ ok: true });
		expect(ig.dialog.value.open).toBe(false);
		expect(last()).toEqual({ tone: 'ok', text: 'Ignoring Paper. 2 found files moved to Dismissed.', removeRule: fake.rules[0].ignored_id });
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(ig.rules.value.map((x) => x.folder)).toEqual(['Paper']);
		expect(fake.files.map((f) => f.state)).toEqual(['dismissed', 'dismissed', 'new', 'new']);
	});

	it('a file in a team folder makes the rule the team\'s', async () => {
		const { ig, fake } = setup();
		ig.openIgnore(fake.files[3]);
		await ig.confirmIgnore();
		expect(fake.calls.filter((c) => c.method === 'post').at(-1)).toMatchObject({ body: { folder: 'Old runs', team_id: TEAM.id } });
		expect(ig.rules.value[0]).toMatchObject({ folder: 'Old runs', owner: { kind: 'team', name: 'SEM team' } });
	});

	it('a refusal stays in the dialog in the server\'s words and changes nothing', async () => {
		const { ig, fake, notes, onChanged } = setup({ ignoredRules: [{ folder: 'paper' }] });
		ig.openIgnore(fake.files[0]);
		ig.dialog.value = { ...ig.dialog.value, target: { ...ig.dialog.value.target!, folder: 'Paper' } };
		const r = await ig.confirmIgnore();
		expect(r).toEqual({ ok: false, message: 'That folder is already ignored.' });
		expect(ig.dialog.value).toMatchObject({ open: true, busy: false, error: 'That folder is already ignored.' });
		expect(notes).toEqual([]);
		expect(onChanged).not.toHaveBeenCalled();
		expect(fake.files.every((f) => f.state === 'new')).toBe(true);
	});

	it('add checks the folder before sending anything, and sends the team for a team folder', async () => {
		const { ig, fake } = setup();
		for (const bad of ['', '/x', 'a//b', 'a/../b', 'a\\b']) expect((await ig.add(bad, null)).ok, bad).toBe(false);
		expect(fake.calls.filter((c) => c.method === 'post')).toEqual([]);
		expect(await ig.add(' Paper/Drafts ', null)).toEqual({ ok: true });
		expect(fake.calls.filter((c) => c.method === 'post').at(-1)!.body).toEqual({ folder: 'Paper/Drafts' });
		expect(await ig.add('Old runs', TEAM.id)).toEqual({ ok: true });
		expect(fake.calls.filter((c) => c.method === 'post').at(-1)!.body).toEqual({ folder: 'Old runs', team_id: TEAM.id });
	});

	it('add answers the server\'s refusal and reloads the list after a 409', async () => {
		const { ig, fake } = setup({ ignoredRules: [{ folder: 'Paper' }] });
		const before = fake.calls.length;
		const r = await ig.add('PAPER', null);
		expect(r).toEqual({ ok: false, message: 'That folder is already ignored.' });
		await vi.waitFor(() => expect(fake.calls.slice(before).some((c) => c.method === 'get' && c.path === '/d1-inbox/ignored-folders')).toBe(true));
	});

	it('a second add while one runs does nothing', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const { ig, fake } = setup({}, (b) => ({ ...b, post: async (p, body, c) => (await gate, b.post(p, body, c)) }));
		const first = ig.add('Paper', null);
		expect(await ig.add('Other', null)).toMatchObject({ ok: false });
		release();
		expect(await first).toEqual({ ok: true });
		expect(fake.rules.map((r) => r.folder)).toEqual(['Paper']);
	});

	it('remove deletes the rule, says whether a rescan is queued, and reads the lists again; the dismissed files stay dismissed', async () => {
		const { ig, fake, last, onChanged } = setup();
		await ig.add('Paper', null);
		onChanged.mockClear();
		await ig.load();
		const r = await ig.remove(ig.rules.value[0]);
		expect(r).toEqual({ ok: true });
		expect(last()).toMatchObject({ tone: 'ok', text: 'Stopped ignoring Paper. A rescan is queued, so it is listed again soon. Files already dismissed stay in Dismissed.' });
		expect(ig.rules.value).toEqual([]);
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(fake.files.filter((f) => f.state === 'dismissed')).toHaveLength(2);
	});

	it('the Remove rule button of the add notice removes that rule by id', async () => {
		const { ig, last } = setup();
		await ig.add('Paper', null);
		const id = (last() as Notice).removeRule!;
		expect(await ig.removeById(id)).toEqual({ ok: true });
		expect(ig.rules.value).toEqual([]);
	});

	it('a failed remove says why next to the list and keeps the rules', async () => {
		const { ig } = setup({ ignoredRules: [{ folder: 'x' }] });
		await ig.load();
		const r = await ig.removeById('00000000-0000-4000-8000-000000009999');
		expect(r).toEqual({ ok: false, message: 'That ignored folder does not exist.' });
		expect(ig.error.value).toBe('That ignored folder does not exist.');
		expect(ig.rules.value).toHaveLength(1);
		expect(ig.removing.value).toBeNull();
	});

	it('a Lab Viewer is read-only: can_remove is false on every rule, and a write is refused in the server\'s words', async () => {
		const { ig } = setup({ viewer: true, ignoredRules: [{ folder: 'x' }] });
		await ig.load();
		expect(ig.readOnly.value).toBe(true);
		expect(await ig.add('y', null)).toEqual({ ok: false, message: 'The Lab Viewer role is read-only: it can look at everything and cannot change anything.' });
	});

	it('a person who may change rules is not read-only, with or without rules (meta.can_change is true)', async () => {
		const { ig } = setup();
		await ig.load();
		expect(ig.canChange.value).toBe(true);
		expect(ig.readOnly.value).toBe(false);
	});

	it('a Lab Viewer with NO rules is read-only too: meta.can_change is false', async () => {
		const { ig } = setup({ viewer: true });
		await ig.load();
		expect(ig.rules.value).toEqual([]);
		expect(ig.canChange.value).toBe(false);
		expect(ig.readOnly.value).toBe(true);
	});

	it('an older server sends no meta: read-only is judged by can_remove on the rules, and false with none', async () => {
		const viewer = setup({ noMeta: true, viewer: true, ignoredRules: [{ folder: 'x' }] });
		await viewer.ig.load();
		expect(viewer.ig.canChange.value).toBeNull();
		expect(viewer.ig.readOnly.value).toBe(true);
		const none = setup({ noMeta: true, viewer: true });
		await none.ig.load();
		expect(none.ig.readOnly.value).toBe(false);
		const own = setup({ noMeta: true });
		await own.ig.load();
		expect(own.ig.readOnly.value).toBe(false);
	});

	it('removing a rule that another rule of the same owner covers says so, names that rule, and queues no rescan', async () => {
		const { ig, fake, last } = setup({ ignoredRules: [{ folder: 'Paper' }, { folder: 'Paper/Drafts' }, { folder: 'Old runs', owner: TEAM }] });
		await ig.load();
		const drafts = ig.rules.value.find((r) => r.folder === 'Paper/Drafts')!;
		expect(await ig.remove(drafts)).toEqual({ ok: true });
		expect(last()).toMatchObject({ tone: 'ok', text: 'Rule removed. Paper/Drafts is still ignored by another rule (Paper).' });
		expect(fake.rules.map((r) => r.folder)).toEqual(['Paper', 'Old runs']);
		// the broader rule's removal covers nothing else: a rescan is queued, as before
		const paper = ig.rules.value.find((r) => r.folder === 'Paper')!;
		await ig.remove(paper);
		expect(last()).toMatchObject({ text: 'Stopped ignoring Paper. A rescan is queued, so it is listed again soon. Files already dismissed stay in Dismissed.' });
	});

	it('a rule of another owner does not cover: the same folder in a team folder is listed again after its own rescan', async () => {
		const { ig, last } = setup({ ignoredRules: [{ folder: 'Paper' }, { folder: 'Paper', owner: TEAM }] });
		await ig.load();
		await ig.remove(ig.rules.value.find((r) => r.owner.kind === 'team')!);
		expect(last()?.text).toContain('A rescan is queued');
	});
});
