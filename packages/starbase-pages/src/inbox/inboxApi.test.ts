import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import {
	InboxApiError, acceptAll, dismissFiles, filesParams, linkFiles, loadAdmin, loadFiles, loadPrefs, loadSummary, parseFile, rescan, restoreFiles, savePrefs, scanAll, undoBatch,
} from './inboxApi';
import { createFakeInbox, exactMatch, foundFile } from './fakeInboxServer';

describe('parseFile', () => {
	it('reads a candidate row and leaves a row with no id out', () => {
		expect(parseFile(null)).toBeNull();
		expect(parseFile({ kind: 'image' })).toBeNull();
		const f = parseFile({
			candidate_id: 'c1', directus_files_id: 'f1', kind: 'sem_image', kind_confidence: '0.8', extracted: { kv: 15 }, origin: 'backlog', state: 'new',
			match_strength: 'short_id', matches: [{ collection: 'physical_samples', record_id: 'r1', via: 'short_id', token: 'abc' }, { nope: 1 }],
			suggested_collection: 'physical_samples', suggested_record_id: 'r1', suggested_label: 'S-1', rel_path: 'Users/a/x.tif', size_bytes: 10,
			owner: { type: 'team', id: 't1', name: 'Additive' },
		});
		expect(f).toMatchObject({
			candidate_id: 'c1', kind: 'sem_image', kind_confidence: 0.8, origin: 'backlog', match_strength: 'short_id', suggested_label: 'S-1',
			matches: [{ collection: 'physical_samples', record_id: 'r1', via: 'short_id', token: 'abc' }], owner: { kind: 'team', id: 't1', name: 'Additive' },
		});
	});
	it('gives odd values a harmless default; a bare owner name is a person', () => {
		const f = parseFile({ candidate_id: 'c1', kind: 'video', state: 'weird', match_strength: 'maybe', matches: 'x', extracted: [], owner: 'Ann' });
		expect(f).toMatchObject({ kind: 'other', state: 'new', match_strength: 'none', matches: [], extracted: {}, owner: { kind: 'person', id: null, name: 'Ann' }, rel_path: '' });
	});
});

describe('filesParams', () => {
	it('sends only what is set', () => {
		expect(filesParams({ tab: 'new', kind: '', folder: undefined, limit: 50, offset: 0 })).toEqual({ tab: 'new', limit: 50, offset: 0 });
	});
});

describe('against the fake server', () => {
	const sample = () => createFakeInbox({ files: [exactMatch(), foundFile(), foundFile({ origin: 'backlog' }), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })] });

	it('loadSummary reads the counts', async () => {
		const s = await loadSummary(sample().api);
		expect(s).toMatchObject({ newCount: 3, olderMatches: 0, person: { has_alias: true } });
	});

	it('loadFiles pages by tab and kind, with the total and the server acceptable count', async () => {
		const fake = sample();
		const pictures = await loadFiles(fake.api, { tab: 'new', kind: 'sem_image,surface_scan,image' });
		expect(pictures.rows).toHaveLength(2);
		expect(pictures).toMatchObject({ total: 2, acceptable: 1 });
		expect(fake.calls[0]).toMatchObject({ method: 'get', path: '/d1-inbox/files', params: { tab: 'new', kind: 'sem_image,surface_scan,image' } });
		const older = await loadFiles(fake.api, { tab: 'older' });
		expect(older.rows).toHaveLength(1);
	});

	it('loadFiles reads a bare array too', async () => {
		const api = { get: vi.fn(async () => ({ data: [{ candidate_id: 'c1', kind: 'image' }] })) } as unknown as HostApi;
		expect(await loadFiles(api, {})).toMatchObject({ total: 1, acceptable: null, rows: [{ candidate_id: 'c1' }] });
	});

	it('link, then undo, moves a file out of New and back', async () => {
		const fake = sample();
		const f = fake.files[0];
		const r = await linkFiles(fake.api, [{ candidate_id: f.candidate_id, collection: 'physical_samples', record_id: f.suggested_record_id as string }]);
		expect(r.linked).toBe(1);
		expect(r.link_batch_id).not.toBe('');
		expect((await loadFiles(fake.api, { tab: 'linked' })).rows.map((x) => [x.candidate_id, x.link_kind, x.linked_label])).toEqual([[f.candidate_id, 'manual', 'S-0042']]);
		expect(await undoBatch(fake.api, r.link_batch_id)).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'linked' })).rows).toHaveLength(0);
		expect((await loadFiles(fake.api, { tab: 'new' })).rows).toHaveLength(3);
	});

	it('accept-all links the exact matches and returns one batch', async () => {
		const fake = sample();
		const r = await acceptAll(fake.api, { tab: 'new' });
		expect(r).toMatchObject({ linked: 1, skipped: [] });
		expect(fake.files.filter((f) => f.link_batch_id === r.link_batch_id)).toHaveLength(1);
		expect(fake.files[0].link_kind).toBe('bulk');
	});

	it('dismiss and restore', async () => {
		const fake = sample();
		const id = fake.files[1].candidate_id;
		expect(await dismissFiles(fake.api, [id])).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'dismissed' })).rows.map((f) => f.candidate_id)).toEqual([id]);
		expect(await restoreFiles(fake.api, [id])).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'dismissed' })).rows).toHaveLength(0);
	});

	it('a second link of a linked file is a 409 whose message is the endpoint\'s', async () => {
		const fake = sample();
		const f = fake.files[0];
		const item = { candidate_id: f.candidate_id, collection: 'physical_samples', record_id: f.suggested_record_id as string };
		await linkFiles(fake.api, [item]);
		await expect(linkFiles(fake.api, [item])).rejects.toMatchObject({ name: 'InboxApiError', status: 409, message: 'Someone already linked this file.' });
	});

	it('rescan: the second request inside 10 minutes is a 429 carrying retry_after_seconds', async () => {
		let t = 1_000_000;
		const fake = createFakeInbox({ now: () => t });
		await expect(rescan(fake.api)).resolves.toBeUndefined();
		t += 60_000;
		const e = await rescan(fake.api).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e).toMatchObject({ status: 429, code: 'RATE_LIMITED', extensions: { retry_after_seconds: 540 } });
		t += 10 * 60_000;
		await expect(rescan(fake.api)).resolves.toBeUndefined();
	});

	it('prefs round-trip over PUT', async () => {
		const fake = sample();
		expect(await loadPrefs(fake.api)).toEqual({ auto_link: false });
		expect(await savePrefs(fake.api, { auto_link: true })).toEqual({ auto_link: true });
		expect(await loadPrefs(fake.api)).toEqual({ auto_link: true });
		expect(fake.calls.at(-2)).toMatchObject({ method: 'put', path: '/d1-inbox/prefs', body: { auto_link: true } });
	});

	it('savePrefs says so when the host has no PUT', async () => {
		const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as HostApi;
		await expect(savePrefs(api, { auto_link: true })).rejects.toBeInstanceOf(InboxApiError);
	});

	it('admin: status, unmatched folders, people without an alias, and Scan all', async () => {
		const fake = sample();
		const a = await loadAdmin(fake.api);
		expect(a.status).toMatchObject({ desired_state: 'running', interval_minutes: 30, error_count: 0, last_error: null });
		expect(a.unmatched_folders).toEqual(['Users/zz9']);
		expect(a.people_without_alias).toEqual([{ person_id: 'p9', full_name: 'Bo Chan', active: true }]);
		await scanAll(fake.api);
		expect(fake.calls.at(-1)).toMatchObject({ method: 'post', path: '/d1-inbox/admin/scan-all' });
	});

	it('a failure with no response is an InboxApiError with a message and no status', async () => {
		const api = { get: vi.fn(async () => { throw new Error('Network Error'); }) } as unknown as HostApi;
		const e = await loadSummary(api).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e.status).toBeUndefined();
		expect(e.message).toBe('Network Error');
	});
});
