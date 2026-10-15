import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { DEFAULT_FILTERS, type InboxFilters } from './inboxModel';
import { createInbox } from './useInbox';
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from './fakeInboxServer';

function setup(files = [exactMatch(), foundFile(), foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/x.al3d' }), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })], now?: () => number, opts: FakeInboxOptions = {}) {
	const fake = createFakeInbox({ files, now, ...opts });
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
		expect(r).toEqual({ ok: false, message: 'That file was already linked.' });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: 'That file was already linked.' });
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

describe('Accept all (a dry run first, then Confirm)', () => {
	const exactFiles = () => [exactMatch(), exactMatch({}, '9ab3c4d5', 'S-0043'), foundFile(), exactMatch({ kind: 'surface_scan' }, '77aa88bb', 'S-9')];

	it('the button needs no server count: it is on when the rows on screen hold a file it would link, and waits while a list loads', async () => {
		const { inbox, fake } = setup(exactFiles());
		expect(inbox.canAcceptAll.value).toBe(false);
		const loadingNow = inbox.load();
		expect(inbox.canAcceptAll.value).toBe(false);
		await loadingNow;
		expect(inbox.preview.value).toMatchObject({ count: 2, exact: true });
		expect(inbox.canAcceptAll.value).toBe(true);
		// the list never asks for the server's acceptable count
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/files').every((c) => !('acceptable' in (c.params ?? {})))).toBe(true);
	});

	it('opening it asks the server for a dry run, changes nothing, and Confirm links exactly the files it listed', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		const opening = inbox.openAccept();
		expect(inbox.acceptDialog.value).toMatchObject({ open: true, loading: true });
		await opening;
		const d = inbox.acceptDialog.value;
		expect(d).toMatchObject({ loading: false, count: 2, hasMore: false, pairsExact: true, ids: [fake.files[0].candidate_id, fake.files[1].candidate_id] });
		expect(d.pairs).toEqual([{ file: '3fa9c1d2_A1.tif', record: 'S-0042' }, { file: '9ab3c4d5_A1.tif', record: 'S-0043' }]);
		expect(d.skipped).toEqual([{ candidate_id: fake.files[3].candidate_id, reason: 'SURFACE_SCAN' }]);
		expect(fake.calls.at(-1)?.body).toMatchObject({ dry_run: true });
		expect(fake.files.every((f) => f.state === 'new')).toBe(true);

		const r = await inbox.confirmAccept();
		expect(r).toEqual({ ok: true });
		const real = fake.calls.filter((c) => c.path === '/d1-inbox/accept-all').at(-1)!;
		expect(real.body).not.toHaveProperty('dry_run');
		expect(real.body).toMatchObject({ candidate_ids: d.ids });
		expect(inbox.acceptDialog.value.open).toBe(false);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Linked 2 found files.', undo: { kind: 'batch' } });
		expect(fake.files.filter((f) => f.link_kind === 'bulk')).toHaveLength(2);
	});

	it('Confirm links the previewed files, not whatever matches by then: a file that arrives between the preview and Confirm is left alone', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		await inbox.openAccept();
		fake.files.push(exactMatch({}, '55ee66ff', 'S-7'));
		await inbox.confirmAccept();
		expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(2);
		expect(fake.files.at(-1)?.state).toBe('new');
	});

	it('against an endpoint that only counts (no ids in the dry run), it confirms by the same filter and says the pairs are examples', async () => {
		const { inbox, fake } = setup(exactFiles(), undefined, { dryRunIds: false });
		await inbox.load();
		await inbox.openAccept();
		expect(inbox.acceptDialog.value).toMatchObject({ count: 2, ids: null, pairsExact: false });
		expect(inbox.acceptDialog.value.pairs).toHaveLength(2);
		await inbox.confirmAccept();
		const real = fake.calls.filter((c) => c.path === '/d1-inbox/accept-all').at(-1)!;
		expect(real.body).not.toHaveProperty('candidate_ids');
		expect(real.body).toMatchObject({ filter: { tab: 'new', strength: 'short_id' } });
		expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(2);
	});

	it('Confirm does nothing while the dry run is still out, and after a failed one', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		const opening = inbox.openAccept();
		expect(await inbox.confirmAccept()).toMatchObject({ ok: false });
		await opening;
		fake.api.post = vi.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'The server is busy.' }] } } }); });
		await inbox.closeAccept();
		await inbox.openAccept();
		expect(inbox.acceptDialog.value).toMatchObject({ loading: false, error: 'The server is busy.' });
		expect(await inbox.confirmAccept()).toMatchObject({ ok: false });
	});

	it('Confirm is guarded against a second click while it runs: one request, one batch', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		await inbox.openAccept();
		const first = inbox.confirmAccept();
		const second = inbox.confirmAccept();
		expect(await second).toMatchObject({ ok: false });
		await first;
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/accept-all' && !(c.body as { dry_run?: boolean }).dry_run)).toHaveLength(1);
	});

	it('says what it reads: with more files than one run takes, hasMore; and nothing to link when nothing matches', async () => {
		const { inbox } = setup([foundFile()]);
		await inbox.load();
		// no exact match on screen and everything loaded: the button stays off, so there is no dialog to open
		expect(inbox.canAcceptAll.value).toBe(false);
		await inbox.openAccept();
		expect(inbox.acceptDialog.value.open).toBe(false);
	});

	it('names a record the caller cannot edit as left for them, and links the rest', async () => {
		const { inbox, fake } = setup(exactFiles(), undefined, { editable: (_c, id) => !id.includes('9ab3c4d5') });
		await inbox.load();
		await inbox.openAccept();
		expect(inbox.acceptDialog.value.count).toBe(1);
		expect(inbox.acceptDialog.value.skipped.map((s) => s.reason).sort()).toEqual(['NOT_EDITABLE', 'SURFACE_SCAN']);
		await inbox.confirmAccept();
		expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(1);
	});

	it('shows the Undo of the returned batch, and one Undo reverses it', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		await inbox.openAccept();
		await inbox.confirmAccept();
		const undo = inbox.notice.value!.undo!;
		expect(undo).toMatchObject({ kind: 'batch' });
		await inbox.undo(undo);
		expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(0);
		expect(inbox.notice.value?.text).toBe('Undone: 2 found files back in your Inbox.');
	});

	it('an Undo is one at a time: a second click while one runs does nothing', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		await inbox.openAccept();
		await inbox.confirmAccept();
		const undo = inbox.notice.value!.undo!;
		const first = inbox.undo(undo);
		expect(inbox.undoing.value).not.toBeNull();
		expect(await inbox.undo(undo)).toMatchObject({ ok: false });
		await first;
		expect(inbox.undoing.value).toBeNull();
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/undo')).toHaveLength(1);
	});

	it('is off on the Recently linked and Dismissed tabs', async () => {
		const { inbox, setFilters } = setup(exactFiles());
		await inbox.load();
		setFilters({ tab: 'linked' });
		expect(inbox.canAcceptAll.value).toBe(false);
	});

	it('a second click on a row\'s Link while its write runs does nothing', async () => {
		const { inbox, fake } = setup(exactFiles());
		await inbox.load();
		const file = inbox.main.value.rows[0];
		const first = inbox.linkSuggested(file);
		expect(await inbox.linkSuggested(file)).toMatchObject({ ok: false });
		await first;
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/link')).toHaveLength(1);
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
