import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { addIgnored, listIgnored, loadIgnored, removeIgnored } from './inboxApi';
import { createFakeInbox, foundFile } from './fakeInboxServer';

const TEAM = { kind: 'team', id: '00000000-0000-4000-8000-000000000021', name: 'SEM team' } as const;
const files = () => [
	foundFile({ rel_path: 'Users/ab1cd/World-Ti Paper/Drafts/a.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/world-ti paper/b.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/World-Ti Paper 2/c.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/World-Ti Paper/linked.tif', state: 'linked' }),
	foundFile({ rel_path: 'Shared/SEM/Old runs/d.tif', owner: TEAM }),
];
const stateOf = (fake: ReturnType<typeof createFakeInbox>) => Object.fromEntries(fake.files.map((f) => [f.rel_path.split('/').pop(), f.state]));

describe('listIgnored / addIgnored / removeIgnored against the fake', () => {
	it('lists nothing at first, then each rule with its owner and can_remove', async () => {
		const fake = createFakeInbox({ files: files() });
		expect(await listIgnored(fake.api)).toEqual([]);
		const added = await addIgnored(fake.api, 'World-Ti Paper/Drafts');
		const [rule] = await listIgnored(fake.api);
		expect(rule).toMatchObject({ ignored_id: added.ignored_id, folder: 'World-Ti Paper/Drafts', owner: { kind: 'person', name: 'Ann Lee' }, can_remove: true });
		expect(fake.calls.at(-1)).toMatchObject({ method: 'get', path: '/d1-inbox/ignored-folders' });
	});

	it('adding sends { folder } for the person and { folder, team_id } for a team, and answers the real dismissed count', async () => {
		const fake = createFakeInbox({ files: files() });
		const own = await addIgnored(fake.api, 'World-Ti Paper');
		expect(fake.calls.at(-1)).toMatchObject({ method: 'post', path: '/d1-inbox/ignored-folders', body: { folder: 'World-Ti Paper' } });
		expect(fake.calls.at(-1)!.body).not.toHaveProperty('team_id');
		// the open files below it are dismissed, whatever the letter case; a longer name, a linked file and the team's file are left alone
		expect(own).toMatchObject({ folder: 'World-Ti Paper', team_id: null, dismissed: 2 });
		expect(stateOf(fake)).toEqual({ 'a.tif': 'dismissed', 'b.tif': 'dismissed', 'c.tif': 'new', 'linked.tif': 'linked', 'd.tif': 'new' });
		const team = await addIgnored(fake.api, 'Old runs', TEAM.id);
		expect(fake.calls.at(-1)).toMatchObject({ body: { folder: 'Old runs', team_id: TEAM.id } });
		expect(team).toMatchObject({ team_id: TEAM.id, dismissed: 1 });
		expect((await listIgnored(fake.api)).map((r) => [r.folder, r.owner.kind])).toEqual([['Old runs', 'team'], ['World-Ti Paper', 'person']]);
	});

	it('removing deletes by id and says whether a rescan was queued (the limit never fails it)', async () => {
		const fake = createFakeInbox({ files: files() });
		const a = await addIgnored(fake.api, 'one');
		const b = await addIgnored(fake.api, 'two');
		expect(await removeIgnored(fake.api, a.ignored_id)).toEqual({ ignored_id: a.ignored_id, folder: 'one', rescan_queued: true, still_ignored: false });
		expect(fake.calls.at(-1)).toMatchObject({ method: 'delete', path: `/d1-inbox/ignored-folders/${a.ignored_id}` });
		// the second removal is inside the 10 minutes of the first rescan: still removed, no rescan
		expect(await removeIgnored(fake.api, b.ignored_id)).toMatchObject({ folder: 'two', rescan_queued: false });
		expect(await listIgnored(fake.api)).toEqual([]);
	});

	it('removing a rule another rule of the same owner covers says still_ignored and queues no rescan', async () => {
		const fake = createFakeInbox({ files: files() });
		await addIgnored(fake.api, 'World-Ti Paper');
		const sub = await addIgnored(fake.api, 'world-ti paper/Drafts');
		expect(await removeIgnored(fake.api, sub.ignored_id)).toEqual({ ignored_id: sub.ignored_id, folder: 'world-ti paper/Drafts', rescan_queued: false, still_ignored: true });
		// no rescan was used up: the next removal that covers nothing queues one
		expect(await removeIgnored(fake.api, fake.rules[0].ignored_id)).toMatchObject({ rescan_queued: true, still_ignored: false });
	});

	it('refuses with the endpoint\'s own words and code', async () => {
		const fake = createFakeInbox({ files: files(), ignoredRules: [{ folder: 'Dup' }], ignoreLimit: 2 });
		const fails = (p: Promise<unknown>) => p.then(() => null, (e) => e);
		expect(await fails(addIgnored(fake.api, 'dup'))).toMatchObject({ status: 409, code: 'ALREADY_IGNORED', message: 'That folder is already ignored.', extensions: { field: 'folder' } });
		expect(await fails(addIgnored(fake.api, 'a//b'))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD', message: 'The folder has an empty part (two slashes in a row).', extensions: { field: 'folder' } });
		expect(await fails(addIgnored(fake.api, 'Users/ab1cd/Paper'))).toMatchObject({ status: 400, message: 'Give the folder relative to your own folder, without Users/ab1cd/.' });
		expect(await fails(addIgnored(fake.api, 'x', '00000000-0000-4000-8000-000000000022'))).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'You are not a member of that team.' });
		await addIgnored(fake.api, 'second');
		expect(await fails(addIgnored(fake.api, 'third'))).toMatchObject({ status: 409, code: 'TOO_MANY_RULES', message: 'You can ignore at most 2 folders. Remove one first.' });
		expect(await fails(removeIgnored(fake.api, '00000000-0000-4000-8000-000000009999'))).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'That ignored folder does not exist.' });
		expect(await fails(createFakeInbox({ files: files(), noFolder: true }).api.post('/d1-inbox/ignored-folders', { folder: 'x' }))).toMatchObject({ response: { status: 409 } });
	});

	it('loadIgnored reads meta.can_change: true for a person, false for a Lab Viewer even with no rules, null from a server that sends no meta', async () => {
		expect(await loadIgnored(createFakeInbox({ files: files() }).api)).toEqual({ rules: [], canChange: true });
		expect(await loadIgnored(createFakeInbox({ files: files(), viewer: true }).api)).toEqual({ rules: [], canChange: false });
		expect(await loadIgnored(createFakeInbox({ files: files(), viewer: true, noMeta: true }).api)).toEqual({ rules: [], canChange: null });
	});

	it('a Lab Viewer reads the rules with can_remove false and every write is refused', async () => {
		const fake = createFakeInbox({ files: files(), viewer: true, ignoredRules: [{ folder: 'Old runs', owner: TEAM }] });
		expect(await listIgnored(fake.api)).toMatchObject([{ folder: 'Old runs', can_remove: false }]);
		expect(await loadIgnored(fake.api)).toMatchObject({ canChange: false });
		await expect(addIgnored(fake.api, 'x')).rejects.toMatchObject({ status: 403, code: 'READ_ONLY_ROLE' });
		await expect(removeIgnored(fake.api, fake.rules[0].ignored_id)).rejects.toMatchObject({ status: 403 });
	});
});

describe('the client reads odd answers harmlessly', () => {
	const api = (data: unknown): HostApi => ({ get: async () => ({ data }), post: async () => ({ data }), patch: async () => ({ data }), delete: async () => ({ data }) });

	it('listIgnored leaves out rows with no id or folder, reads a bare list, and treats can_remove as true only when true', async () => {
		const row = { ignored_id: 'r1', folder: 'x', owner: { kind: 'team', id: 't1', name: 'SEM' }, created_at: '2026-10-16T09:00:00Z' };
		expect(await listIgnored(api({ data: [row, { folder: 'no id' }, { ignored_id: 'r2' }, null, { ...row, ignored_id: 'r3', can_remove: true }] }))).toEqual([
			{ ...row, can_remove: false },
			{ ...row, ignored_id: 'r3', can_remove: true },
		]);
		expect(await listIgnored(api([row]))).toHaveLength(1);
		expect(await listIgnored(api({}))).toEqual([]);
	});

	it('loadIgnored takes can_change only when it is a boolean', async () => {
		expect(await loadIgnored(api({ data: [], meta: { can_change: false } }))).toEqual({ rules: [], canChange: false });
		expect(await loadIgnored(api({ data: [], meta: { can_change: 'no' } }))).toEqual({ rules: [], canChange: null });
		expect(await loadIgnored(api({ data: [], meta: {} }))).toEqual({ rules: [], canChange: null });
		expect(await loadIgnored(api([]))).toEqual({ rules: [], canChange: null });
	});

	it('addIgnored and removeIgnored fall back to what was asked for', async () => {
		expect(await addIgnored(api({ data: { ignored_id: 'r1', dismissed: '4', team_id: null } }), 'x')).toEqual({ ignored_id: 'r1', folder: 'x', team_id: null, dismissed: 4 });
		expect(await addIgnored(api({ data: {} }), 'x')).toMatchObject({ dismissed: 0, team_id: null });
		expect(await removeIgnored(api({ data: { rescan_queued: true } }), 'r9')).toEqual({ ignored_id: 'r9', folder: '', rescan_queued: true, still_ignored: false });
		expect(await removeIgnored(api({ data: { folder: 'x', rescan_queued: false, still_ignored: true } }), 'r9')).toMatchObject({ still_ignored: true, rescan_queued: false });
	});
});
