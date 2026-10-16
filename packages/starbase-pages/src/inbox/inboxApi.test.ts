import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import {
	InboxApiError, acceptAll, dismissFiles, filesParams, linkFiles, loadAdmin, loadFiles, loadPicture, loadPrefs, loadSummary, parseFile, rescan, restoreFiles, savePrefs, scanAll, undoBatch,
} from './inboxApi';
import { createFakeInbox, exactMatch, foundFile } from './fakeInboxServer';

describe('parseFile', () => {
	it('reads a candidate row as d1-inbox sends it, and leaves a row with no id out', () => {
		expect(parseFile(null)).toBeNull();
		expect(parseFile({ kind: 'image' })).toBeNull();
		const f = parseFile({
			candidate_id: 'c1', directus_files_id: 'f1', name: 'x.tif', mime_type: 'image/tiff', adopted: false, kind: 'sem_image', kind_confidence: '0.8', extracted: { kv: 15 }, origin: 'backlog', state: 'new',
			match_strength: 'short_id', matches: [{ collection: 'physical_samples', record_id: 'r1', via: 'short_id', token: 'abc' }, { nope: 1 }],
			suggested_collection: 'physical_samples', suggested_record_id: 'r1', suggested_label: 'S-1', suggested_can_edit: true, rel_path: 'Users/a/x.tif', size_bytes: 10,
			owner: { kind: 'team', id: 't1', name: 'Additive' },
		});
		expect(f).toMatchObject({
			candidate_id: 'c1', name: 'x.tif', mime_type: 'image/tiff', adopted: false, kind: 'sem_image', kind_confidence: 0.8, origin: 'backlog', match_strength: 'short_id', suggested_label: 'S-1', suggested_can_edit: true,
			matches: [{ collection: 'physical_samples', record_id: 'r1', via: 'short_id', token: 'abc' }], owner: { kind: 'team', id: 't1', name: 'Additive' },
		});
	});
	it('gives odd values a harmless default; a bare owner name is a person', () => {
		const f = parseFile({ candidate_id: 'c1', kind: 'video', state: 'weird', match_strength: 'maybe', matches: 'x', extracted: [], owner: 'Ann' });
		expect(f).toMatchObject({ kind: 'other', state: 'new', match_strength: 'none', matches: [], extracted: {}, owner: { kind: 'person', id: null, name: 'Ann' }, rel_path: '' });
	});
});

describe('has_thumbnail', () => {
	it('is read as a boolean: true only when the server says true, and a server that leaves it out means no picture', () => {
		expect(parseFile({ candidate_id: 'c1', has_thumbnail: true })!.has_thumbnail).toBe(true);
		expect(parseFile({ candidate_id: 'c1', has_thumbnail: false })!.has_thumbnail).toBe(false);
		expect(parseFile({ candidate_id: 'c1' })!.has_thumbnail).toBe(false);
		expect(parseFile({ candidate_id: 'c1', has_thumbnail: 'yes' })!.has_thumbnail).toBe(false);
		expect(parseFile({ candidate_id: 'c1', has_thumbnail: 1 })!.has_thumbnail).toBe(false);
	});
});

describe('loadPicture', () => {
	const withPictures = (over: Parameters<typeof createFakeInbox>[0] = {}) => createFakeInbox({ files: [foundFile({ has_thumbnail: true }), foundFile()], ...over });

	it('fetches the thumb and the preview as blobs with the session (a GET with responseType blob) and answers an object URL', async () => {
		const fake = withPictures();
		const get = vi.spyOn(fake.api, 'get');
		const create = vi.spyOn(URL, 'createObjectURL');
		const id = fake.files[0].candidate_id;
		const thumb = await loadPicture(fake.api, id, 'thumb');
		const preview = await loadPicture(fake.api, id, 'preview');
		expect(thumb).toMatch(/^blob:/);
		expect(preview).toMatch(/^blob:/);
		expect(thumb).not.toBe(preview);
		expect(get.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			[`/d1-inbox/files/${id}/thumb`, { responseType: 'blob' }],
			[`/d1-inbox/files/${id}/preview`, { responseType: 'blob' }],
		]);
		expect(create).toHaveBeenCalledTimes(2);
		expect((create.mock.calls[0][0] as Blob).type).toBe('image/png');
		URL.revokeObjectURL(thumb);
		URL.revokeObjectURL(preview);
		create.mockRestore();
	});

	it('a file with no picture, or one the caller cannot see, is an InboxApiError 404 (the fake answers the same for both)', async () => {
		const fake = withPictures();
		await expect(loadPicture(fake.api, fake.files[1].candidate_id, 'thumb')).rejects.toMatchObject({ name: 'InboxApiError', status: 404 });
		await expect(loadPicture(fake.api, '00000000-0000-4000-8000-00000000dead', 'preview')).rejects.toMatchObject({ status: 404 });
	});

	it('a server error carries its status and does not leak an object URL', async () => {
		const fake = withPictures({ thumbFails: true });
		const create = vi.spyOn(URL, 'createObjectURL');
		await expect(loadPicture(fake.api, fake.files[0].candidate_id, 'thumb')).rejects.toMatchObject({ status: 500 });
		expect(create).not.toHaveBeenCalled();
		create.mockRestore();
	});

	it('an answer that is not a picture (JSON, an empty body, text) is refused', async () => {
		const answer = (data: unknown) => ({ get: vi.fn(async () => ({ data })) }) as unknown as HostApi;
		await expect(loadPicture(answer({ data: [] }), 'c1', 'thumb')).rejects.toBeInstanceOf(InboxApiError);
		await expect(loadPicture(answer(new Blob([])), 'c1', 'thumb')).rejects.toBeInstanceOf(InboxApiError);
		await expect(loadPicture(answer(new Blob(['<html>'], { type: 'text/html' })), 'c1', 'thumb')).rejects.toBeInstanceOf(InboxApiError);
		const url = await loadPicture(answer(new Uint8Array([1, 2, 3]).buffer), 'c1', 'thumb');
		expect(url).toMatch(/^blob:/);
		URL.revokeObjectURL(url);
	});
});

describe('filesParams', () => {
	it('sends only what is set', () => {
		expect(filesParams({ tab: 'new', kind: '', folder: undefined, limit: 50, offset: 0 })).toEqual({ tab: 'new', limit: 50, offset: 0 });
	});
});

describe('against the fake server (d1-inbox\'s shapes)', () => {
	const sample = () => createFakeInbox({ files: [exactMatch(), foundFile(), foundFile({ origin: 'backlog' }), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })] });

	it('loadSummary reads the counts', async () => {
		const s = await loadSummary(sample().api);
		expect(s).toMatchObject({ newCount: 3, olderMatches: 0, person: { has_alias: true } });
	});

	it('loadFiles pages by tab and kind with the total; it never asks for meta.acceptable', async () => {
		const fake = sample();
		const pictures = await loadFiles(fake.api, { tab: 'new', kind: 'sem_image,surface_scan,image' });
		expect(pictures.rows).toHaveLength(2);
		expect(pictures).toMatchObject({ total: 2, acceptable: null });
		expect(fake.calls[0]).toMatchObject({ method: 'get', path: '/d1-inbox/files', params: { tab: 'new', kind: 'sem_image,surface_scan,image' } });
		expect(fake.calls[0].params).not.toHaveProperty('acceptable');
		const older = await loadFiles(fake.api, { tab: 'older' });
		expect(older.rows).toHaveLength(1);
	});

	it('loadFiles reads the server\'s acceptable count when it is there, and a bare array', async () => {
		const withMeta = { get: vi.fn(async () => ({ data: { data: [{ candidate_id: 'c1', kind: 'image' }], meta: { total: 9, limit: 50, offset: 0, acceptable: 4 } } })) } as unknown as HostApi;
		expect(await loadFiles(withMeta, {})).toMatchObject({ total: 9, acceptable: 4 });
		const bare = { get: vi.fn(async () => ({ data: [{ candidate_id: 'c1', kind: 'image' }] })) } as unknown as HostApi;
		expect(await loadFiles(bare, {})).toMatchObject({ total: 1, acceptable: null, rows: [{ candidate_id: 'c1' }] });
	});

	it('link, then undo, moves a file out of New and back', async () => {
		const fake = sample();
		const f = fake.files[0];
		const r = await linkFiles(fake.api, [{ candidate_id: f.candidate_id, collection: 'physical_samples', record_id: f.suggested_record_id as string }]);
		expect(r.linked).toBe(1);
		expect(r.items).toMatchObject([{ candidate_id: f.candidate_id, collection: 'physical_samples' }]);
		expect(r.link_batch_id).not.toBe('');
		expect((await loadFiles(fake.api, { tab: 'linked' })).rows.map((x) => [x.candidate_id, x.link_kind, x.linked_label])).toEqual([[f.candidate_id, 'manual', 'S-0042']]);
		expect(await undoBatch(fake.api, r.link_batch_id)).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'linked' })).rows).toHaveLength(0);
		expect((await loadFiles(fake.api, { tab: 'new' })).rows).toHaveLength(3);
	});

	it('a link to a record the caller cannot edit is refused 403 in the endpoint\'s words, and changes nothing', async () => {
		const fake = createFakeInbox({ files: [exactMatch()], editable: () => false });
		const f = fake.files[0];
		const e = await linkFiles(fake.api, [{ candidate_id: f.candidate_id, collection: 'physical_samples', record_id: f.suggested_record_id as string }]).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'You can only link a file to a record you can edit.' });
		expect(fake.files[0].state).toBe('new');
	});

	it('accept-all links the exact matches in one batch, skipping what it should, and reads the count', async () => {
		const fake = createFakeInbox({ files: [exactMatch(), exactMatch({}, '9ab3c4d5', 'S-0043'), exactMatch({ kind: 'surface_scan' }, '77aa88bb', 'S-9'), exactMatch({ kind: 'document', rel_path: 'Users/a/55ee66ff.pdf' }, '55ee66ff', 'S-7')] });
		const r = await acceptAll(fake.api, { tab: 'new' });
		expect(r).toMatchObject({ linked: 3, dry_run: false, has_more: false, skipped: [{ reason: 'SURFACE_SCAN' }] });
		expect(r.items).toHaveLength(3);
		expect(fake.files.filter((f) => f.link_batch_id === r.link_batch_id)).toHaveLength(3);
		expect(fake.files.every((f) => f.kind === 'surface_scan' || f.link_kind === 'bulk')).toBe(true);
	});

	it('an accept-all dry run changes nothing and answers the count, the files and what it would leave', async () => {
		const fake = createFakeInbox({ files: [exactMatch(), exactMatch({ kind: 'surface_scan' }, '77aa88bb', 'S-9')], editable: () => true });
		const r = await acceptAll(fake.api, { tab: 'new' }, { dryRun: true });
		expect(fake.calls.at(-1)?.body).toMatchObject({ dry_run: true, filter: { tab: 'new' } });
		expect(r).toMatchObject({ dry_run: true, linked: 0, acceptable: 1, link_batch_id: '', skipped: [{ reason: 'SURFACE_SCAN' }] });
		expect(r.ids).toEqual([fake.files[0].candidate_id]);
		expect(fake.files.every((f) => f.state === 'new')).toBe(true);
	});

	it('accept-all asked for exact files links exactly those', async () => {
		const fake = createFakeInbox({ files: [exactMatch(), exactMatch({}, '9ab3c4d5', 'S-0043')] });
		const first = fake.files[0].candidate_id;
		const r = await acceptAll(fake.api, { tab: 'new' }, { candidateIds: [first] });
		expect(fake.calls.at(-1)?.body).toMatchObject({ candidate_ids: [first] });
		expect(r.linked).toBe(1);
		expect(fake.files.map((f) => f.state)).toEqual(['linked', 'new']);
	});

	it('reads the count of an accept-all answer however it is spelt: count, acceptable, ids, items, or a list in linked', async () => {
		const answer = (data: unknown) => ({ post: vi.fn(async () => ({ data })) }) as unknown as HostApi;
		expect(await acceptAll(answer({ data: { dry_run: true, count: 7, ids: ['a', 'b'], has_more: true, skipped: [] } }), {}, { dryRun: true })).toMatchObject({ acceptable: 7, ids: ['a', 'b'], has_more: true, linked: 0 });
		expect(await acceptAll(answer({ data: { dry_run: true, acceptable: 2, items: [{ candidate_id: 'a', record_id: 'r', collection: 'physical_samples' }] } }), {}, { dryRun: true })).toMatchObject({ acceptable: 2, ids: ['a'] });
		expect(await acceptAll(answer({ data: { link_batch_id: 'b1', count: 2, linked: [{ candidate_id: 'a', record_id: 'r' }, { candidate_id: 'b', record_id: 'r' }], skipped: [{ candidate_id: 'z', reason: 'COPY' }] } }), {})).toMatchObject({ linked: 2, link_batch_id: 'b1', skipped: [{ reason: 'COPY' }] });
	});

	it('a second link of a linked file is a 409 whose message is the endpoint\'s', async () => {
		const fake = sample();
		const f = fake.files[0];
		const item = { candidate_id: f.candidate_id, collection: 'physical_samples', record_id: f.suggested_record_id as string };
		await linkFiles(fake.api, [item]);
		// the same person repeating the same link is a no-op the endpoint answers as already linked
		expect((await linkFiles(fake.api, [item])).items[0]).toMatchObject({ already_linked: true });
		await expect(linkFiles(fake.api, [{ ...item, record_id: 'a-different-record' }])).rejects.toMatchObject({ name: 'InboxApiError', status: 409, code: 'ALREADY_LINKED', message: 'That file was already linked.' });
	});

	it('dismiss and restore', async () => {
		const fake = sample();
		const id = fake.files[1].candidate_id;
		expect(await dismissFiles(fake.api, [id])).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'dismissed' })).rows.map((f) => f.candidate_id)).toEqual([id]);
		expect(await restoreFiles(fake.api, [id])).toBe(1);
		expect((await loadFiles(fake.api, { tab: 'dismissed' })).rows).toHaveLength(0);
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

	it('rescan with no folder is a 409 NO_FOLDER in the endpoint\'s words', async () => {
		const e = await rescan(createFakeInbox({ noFolder: true }).api).catch((x) => x);
		expect(e).toMatchObject({ status: 409, code: 'NO_FOLDER' });
		expect(e.message).toContain('uni alias');
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

	it('admin: the daemon verdict, status, errors, unmatched folders, people without an alias (with their login), the queue, and Scan all', async () => {
		const fake = sample();
		const a = await loadAdmin(fake.api);
		expect(a.status).toMatchObject({ desired_state: 'running', interval_minutes: 30, daemon: 'alive', error_count: 0, last_error: null });
		expect(a.unmatched_folders).toEqual(['Users/zz9']);
		expect(a.people_without_alias).toEqual([{ person_id: 'p9', full_name: 'Bo Chan', active: true, has_login: true }]);
		expect(a.queue).toEqual({ queued: 0, running: 0 });
		expect(a.candidates.new).toBe(4);
		await scanAll(fake.api);
		expect(fake.calls.at(-1)).toMatchObject({ method: 'post', path: '/d1-inbox/admin/scan-all' });
		// a second Scan all while one waits is the endpoint's 409
		await expect(scanAll(fake.api)).rejects.toMatchObject({ status: 409, code: 'ALREADY_QUEUED' });
		expect((await loadAdmin(fake.api)).queued_requests).toBe(1);
	});

	it('admin: errors list as {at, message}, and an unknown daemon word is null', async () => {
		const api = { get: vi.fn(async () => ({ data: { data: { status: { daemon: 'weird' }, errors: [{ at: '2026-10-15T10:00:00Z', message: 'boom' }, 'plain text'], unmatched_folders: [], people_without_alias: [] } } })) } as unknown as HostApi;
		const a = await loadAdmin(api);
		expect(a.status.daemon).toBeNull();
		expect(a.errors).toEqual([{ at: '2026-10-15T10:00:00Z', message: 'boom' }, { at: null, message: 'plain text' }]);
	});

	it('a failure with no response is an InboxApiError with a message and no status', async () => {
		const api = { get: vi.fn(async () => { throw new Error('Network Error'); }) } as unknown as HostApi;
		const e = await loadSummary(api).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e.status).toBeUndefined();
		expect(e.message).toBe('Network Error');
	});
});
