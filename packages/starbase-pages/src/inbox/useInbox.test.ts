import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { DEFAULT_FILTERS, type InboxFilters } from './inboxModel';
import { createInbox } from './useInbox';
import { createFakeInbox, exactMatch, foundFile } from './fakeInboxServer';

function setup(files = [exactMatch(), foundFile(), foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/x.al3d' }), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })], now?: () => number) {
	const fake = createFakeInbox({ files, now });
	let filters: InboxFilters = { ...DEFAULT_FILTERS };
	const changed = vi.fn();
	const inbox = createInbox({ api: fake.api, getFilters: () => filters, onChanged: changed });
	return { fake, inbox, changed, setFilters: (f: Partial<InboxFilters>) => (filters = { ...filters, ...f }) };
}

describe('loading', () => {
	it('loads the picture rows, and only the count of Other files while that section is closed', async () => {
		const { inbox, fake } = setup();
		await inbox.load();
		expect(inbox.main.value.rows).toHaveLength(3);
		expect(inbox.main.value.total).toBe(3);
		expect(inbox.other.value).toMatchObject({ rows: [], total: 1 });
		expect(inbox.loading.value).toBe(false);
		const otherCall = fake.calls.find((c) => c.params?.kind === 'document,other');
		expect(otherCall?.params).toMatchObject({ limit: 1 });
	});
	it('opening Other files loads its rows once', async () => {
		const { inbox, fake } = setup();
		await inbox.load();
		await inbox.toggleOther(true);
		expect(inbox.other.value.rows.map((f) => f.kind)).toEqual(['document']);
		const before = fake.calls.length;
		await inbox.toggleOther(false);
		await inbox.toggleOther(true);
		expect(fake.calls.length).toBe(before);
	});
	it('a document kind filter opens the section by itself and leaves the picture rows out', async () => {
		const { inbox, setFilters } = setup();
		setFilters({ kind: 'document' });
		await inbox.load();
		expect(inbox.main.value.rows).toEqual([]);
		expect(inbox.otherOpen.value).toBe(true);
		expect(inbox.other.value.rows).toHaveLength(1);
	});
	it('a failed reload keeps what was shown and says why', async () => {
		const { inbox, fake } = setup();
		await inbox.load();
		const get = vi.spyOn(fake.api, 'get').mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500, data: { errors: [{ message: 'The server is busy.' }] } } }));
		await inbox.load();
		expect(inbox.main.value.rows).toHaveLength(3);
		expect(inbox.error.value).toBe('The server is busy.');
		get.mockRestore();
	});
	it('drops a late answer: the latest load wins', async () => {
		const { fake, setFilters } = setup();
		const resolvers: Array<() => void> = [];
		const slow: HostApi = {
			...fake.api,
			get: (path, config) => new Promise((resolve) => resolvers.push(() => resolve(fake.api.get(path, config)))),
		};
		let filters: InboxFilters = { ...DEFAULT_FILTERS };
		const inbox = createInbox({ api: slow, getFilters: () => filters });
		const first = inbox.load();
		filters = { ...DEFAULT_FILTERS, kind: 'sem_image' };
		const second = inbox.load();
		// both pairs of requests are out; the second load's answers arrive first, the first load's last
		resolvers.splice(0).reverse().forEach((r) => r());
		await Promise.all([first, second]);
		expect(inbox.main.value.rows.map((f) => f.kind)).toEqual(['sem_image']);
		void setFilters;
	});
});

describe('linking', () => {
	it('links a file to the record its path names, drops the row, and offers one Undo for the batch', async () => {
		const { inbox, changed } = setup();
		await inbox.load();
		const file = inbox.main.value.rows.find((f) => f.match_strength === 'short_id')!;
		const r = await inbox.linkSuggested(file);
		expect(r).toEqual({ ok: true });
		expect(inbox.main.value.rows.map((f) => f.candidate_id)).not.toContain(file.candidate_id);
		expect(inbox.main.value.total).toBe(2);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Linked 1 found file.', undo: { kind: 'batch' } });
		expect(changed).toHaveBeenCalledTimes(1);
		await inbox.undo(inbox.notice.value!.undo!);
		expect(inbox.notice.value?.text).toBe('Undone: 1 found file back in your Inbox.');
		expect(inbox.main.value.rows.map((f) => f.candidate_id)).toContain(file.candidate_id);
	});
	it('a file that names no record cannot be linked without choosing one', async () => {
		const { inbox } = setup();
		await inbox.load();
		const plain = inbox.main.value.rows.find((f) => f.match_strength === 'none')!;
		expect(await inbox.linkSuggested(plain)).toMatchObject({ ok: false });
		const chosen = await inbox.link(plain, 'physical_samples', 's-chosen');
		expect(chosen).toEqual({ ok: true });
	});
	it('a refused link says the endpoint\'s words and reloads (someone else got there first)', async () => {
		const { inbox, fake } = setup();
		await inbox.load();
		const file = inbox.main.value.rows.find((f) => f.match_strength === 'short_id')!;
		fake.files.find((f) => f.candidate_id === file.candidate_id)!.state = 'linked';
		const r = await inbox.linkSuggested(file);
		expect(r).toEqual({ ok: false, message: 'Someone already linked this file.' });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: 'Someone already linked this file.' });
		await vi.waitFor(() => expect(inbox.main.value.rows.map((f) => f.candidate_id)).not.toContain(file.candidate_id));
	});
	it('marks a row busy while its write runs', async () => {
		const { inbox } = setup();
		await inbox.load();
		const file = inbox.main.value.rows[0];
		const p = inbox.dismiss(file);
		expect(inbox.isBusy(file.candidate_id)).toBe(true);
		await p;
		expect(inbox.isBusy(file.candidate_id)).toBe(false);
	});
});

describe('dismissing', () => {
	it('moves a file to Dismissed with an Undo that restores it', async () => {
		const { inbox, setFilters } = setup();
		await inbox.load();
		const file = inbox.main.value.rows[1];
		await inbox.dismiss(file);
		expect(inbox.notice.value).toMatchObject({ undo: { kind: 'restore', ids: [file.candidate_id] } });
		setFilters({ tab: 'dismissed' });
		await inbox.load();
		expect(inbox.main.value.rows.map((f) => f.candidate_id)).toEqual([file.candidate_id]);
		await inbox.restore(inbox.main.value.rows[0]);
		expect(inbox.main.value.rows).toHaveLength(0);
	});
});

describe('Accept all', () => {
	it('previews the count the server evaluated, and links the exact matches in one batch with one Undo', async () => {
		const { inbox, fake } = setup([exactMatch(), exactMatch({}, '9ab3c4d5', 'S-0043'), foundFile(), exactMatch({ kind: 'surface_scan' }, '77aa88bb', 'S-9')]);
		await inbox.load();
		expect(inbox.preview.value.count).toBe(2);
		expect(inbox.canAcceptAll.value).toBe(true);
		await inbox.acceptAllNow();
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Linked 2 found files.', undo: { kind: 'batch' } });
		expect(fake.files.filter((f) => f.link_kind === 'bulk')).toHaveLength(2);
		expect(inbox.canAcceptAll.value).toBe(false);
		await inbox.undo(inbox.notice.value!.undo!);
		expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(0);
	});
	it('is off on the Recently linked and Dismissed tabs and when nothing matches exactly', async () => {
		const { inbox, setFilters } = setup([foundFile()]);
		await inbox.load();
		expect(inbox.canAcceptAll.value).toBe(false);
		setFilters({ tab: 'linked' });
		expect(inbox.canAcceptAll.value).toBe(false);
	});
	it('says so when nothing was linked', async () => {
		const { inbox } = setup([foundFile()]);
		await inbox.load();
		await inbox.acceptAllNow();
		expect(inbox.notice.value).toMatchObject({ tone: 'warn' });
		expect(inbox.notice.value?.undo).toBeUndefined();
	});
});

describe('Rescan my folder', () => {
	it('queues once and shows the rate-limit message on the 429, with the minutes from the server', async () => {
		let t = 1_000_000;
		const { inbox } = setup([], () => t);
		expect(await inbox.rescanNow()).toEqual({ ok: true });
		expect(inbox.notice.value?.text).toBe('Rescan requested. New files appear here within a few minutes.');
		t += 60_000;
		const r = await inbox.rescanNow();
		expect(r.ok).toBe(false);
		expect(inbox.notice.value).toMatchObject({ tone: 'warn' });
		expect(inbox.notice.value?.text).toBe('A scan of your folder is already queued or ran recently. A folder can be rescanned once every 10 minutes. Try again in 9 minutes.');
		expect(inbox.rescanning.value).toBe(false);
	});
});
