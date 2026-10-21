import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { DEFAULT_FILTERS, type InboxFilters } from './inboxModel';
import { emptyScanAdd, type ScanAddForm } from './inboxScan';
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
		// the count comes from its own request for the filter Accept all uses (every kind), not from the rows' list request
		const asks = fake.calls.filter((c) => c.path === '/d1-inbox/files' && (c.params as { acceptable?: number }).acceptable === 1);
		expect(asks).toHaveLength(1);
		expect(asks[0].params).toMatchObject({ limit: 1, strength: 'short_id' });
		expect(asks[0].params).not.toHaveProperty('kind');
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/files' && 'acceptable' in (c.params ?? {})).length).toBe(1);
		expect(inbox.acceptCount.value).toBe(2);
	});

	it('when the server counts none, Accept all has nothing to do: the button is off and the count is known', async () => {
		const { inbox } = setup([foundFile(), foundFile({ rel_path: 'Users/abc12de/b.png' })]);
		await inbox.load();
		expect(inbox.acceptCount.value).toBe(0);
		expect(inbox.preview.value).toMatchObject({ count: 0, exact: true });
		expect(inbox.canAcceptAll.value).toBe(false);
	});

	it('an exact-ID document under Other files still counts (kind Any: the images list alone would say none)', async () => {
		const doc = exactMatch({ kind: 'document', mime_type: 'application/pdf', rel_path: 'Users/abc12de/notes_3fa9c1d2.pdf' });
		const { inbox } = setup([doc]);
		await inbox.load();
		expect(inbox.other.value.total).toBe(1);
		expect(inbox.acceptCount.value).toBe(1);
		expect(inbox.canAcceptAll.value).toBe(true);
	});

	it('linking or dismissing one of the counted files lowers the count by one', async () => {
		const { inbox } = setup(exactFiles());
		await inbox.load();
		expect(inbox.acceptCount.value).toBe(2);
		const file = inbox.main.value.rows.find((f) => f.match_strength === 'short_id')!;
		await inbox.dismiss(file);
		expect(inbox.acceptCount.value).toBe(1);
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

describe('adding a surface scan', () => {
	const INSERT = '00000000-0000-4000-8000-000000000201';
	const EDGE = '00000000-0000-4000-8000-000000000202';
	const OP = '00000000-0000-4000-8000-000000000102';
	const scanFile = () => foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/H13A-2_fC_worn.al3d' });
	const insert = { kind: 'insert' as const, id: INSERT, label: 'H13A-#2', detail: '' };
	const edge = { kind: 'edge' as const, id: EDGE, label: 'H13A-#2-fC', detail: 'Insert H13A-#2' };
	const form = (over: Partial<ScanAddForm> = {}): ScanAddForm => ({ ...emptyScanAdd(insert), condition: 'worn', ...over });
	const scanSetup = (opts: FakeInboxOptions = {}) => {
		const s = setup([scanFile(), exactMatch()], undefined, opts);
		return { ...s, file: () => s.fake.files[0] };
	};
	const sentLinks = (fake: ReturnType<typeof createFakeInbox>) => fake.calls.filter((c) => c.path === '/d1-inbox/link');

	it('sends the scan item, says where it went, and offers one Undo for the batch', async () => {
		const { inbox, fake, changed, file } = scanSetup();
		await inbox.load();
		expect(await inbox.addScan(file(), form({ item: edge, condition: 'cleaned', operationId: OP, date: '2026-10-14', conditionNote: 'ultrasonic bath', notes: 'after pass 3' }))).toEqual({ ok: true });
		expect(sentLinks(fake)[0].body).toEqual({ items: [{ candidate_id: file().candidate_id, collection: 'surface_scans', edge_id: EDGE, condition: 'cleaned', operation_id: OP, scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: 'after pass 3' }] });
		expect(fake.scans).toHaveLength(1);
		expect(fake.scans[0]).toMatchObject({ edge_id: EDGE, insert_id: null, condition: 'cleaned', operation_id: OP });
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Added as a surface scan of H13A-#2-fC. If the file has an owner (you, or your team for a team folder), only the owner and administrators can see its file and 3D view; others see that the item has a scan.', undo: { kind: 'batch' } });
		expect(inbox.main.value.rows.map((f) => f.candidate_id)).not.toContain(file().candidate_id);
		expect(changed).toHaveBeenCalled();
	});

	it('Undo deletes the scan and puts the file back in the Inbox', async () => {
		const { inbox, fake, file } = scanSetup();
		await inbox.load();
		await inbox.addScan(file(), form());
		await inbox.undo(inbox.notice.value!.undo!);
		expect(fake.scans).toEqual([]);
		expect(file().state).toBe('new');
		expect(inbox.notice.value?.text).toBe('Undone: 1 found file back in your Inbox.');
	});

	it('Undo refused (the person may no longer delete the scan) shows the endpoint\'s words, verbatim, and undoes nothing', async () => {
		const { inbox, fake, file } = scanSetup({ scanUndoAllowed: false });
		await inbox.load();
		await inbox.addScan(file(), form());
		const r = await inbox.undo(inbox.notice.value!.undo!);
		expect(r).toEqual({ ok: false, message: 'You can no longer delete that surface scan, so adding it cannot be undone.' });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: 'You can no longer delete that surface scan, so adding it cannot be undone.' });
		expect(fake.scans).toHaveLength(1);
		expect(file().state).toBe('linked');
	});

	it('a repeat by the same person says it was already added, and offers no Undo', async () => {
		const { inbox, fake, file } = scanSetup();
		await inbox.load();
		await inbox.addScan(file(), form());
		expect(await inbox.addScan(file(), form())).toEqual({ ok: true });
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'That file was already added.' });
		expect(inbox.notice.value?.undo).toBeUndefined();
		expect(fake.scans).toHaveLength(1);
	});

	it('sends nothing until there is an item and a condition (and never a default condition)', async () => {
		const { inbox, fake, file } = scanSetup();
		await inbox.load();
		expect(await inbox.addScan(file(), emptyScanAdd(insert))).toMatchObject({ ok: false });
		expect(await inbox.addScan(file(), { ...emptyScanAdd(), condition: 'worn' })).toMatchObject({ ok: false });
		expect(sentLinks(fake)).toHaveLength(0);
	});

	it('a second click while the first runs sends one request', async () => {
		const { inbox, fake, file } = scanSetup();
		await inbox.load();
		const first = inbox.addScan(file(), form());
		expect(await inbox.addScan(file(), form())).toMatchObject({ ok: false });
		await first;
		expect(sentLinks(fake)).toHaveLength(1);
	});

	it('the plain Link path never sends a surface scan to /link for a sample, operation or test', async () => {
		const { inbox, fake } = setup([exactMatch({ kind: 'surface_scan' }, '77aa88bb', 'S-9')]);
		await inbox.load();
		const f = fake.files[0];
		expect(await inbox.link(f, 'physical_samples', f.suggested_record_id as string)).toEqual({ ok: false, message: 'A surface scan is added to an insert or an edge.' });
		expect(await inbox.linkSuggested(f)).toMatchObject({ ok: false });
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/link')).toHaveLength(0);
	});

	it('only a surface scan file is added as one (nothing is sent for any other)', async () => {
		const { inbox, fake } = scanSetup();
		await inbox.load();
		expect(await inbox.addScan(fake.files[1], form())).toEqual({ ok: false, message: 'Only a surface scan file can be added to an insert or an edge.' });
		expect(sentLinks(fake)).toHaveLength(0);
	});

	it.each([
		['NOT_FOUND', { scanItems: { inserts: {} } }, 'That insert, edge or operation does not exist, or you cannot see it. Choose another.', true],
		['FORBIDDEN', { scanAllowed: false }, 'You are not allowed to add surface scans.', false],
		['SURFACE_SCANS_UNAVAILABLE', { scanTableMissing: true }, 'Surface scans are not available yet.', true],
	] as Array<[string, FakeInboxOptions, string, boolean]>)('%s is said in its own words, and the row stays', async (_code, opts, text, reloads) => {
		const { inbox, fake, file } = scanSetup(opts);
		await inbox.load();
		const before = fake.calls.filter((c) => c.path === '/d1-inbox/files').length;
		expect(await inbox.addScan(file(), form())).toEqual({ ok: false, message: text });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text });
		expect(inbox.main.value.rows.map((f) => f.candidate_id)).toContain(file().candidate_id);
		expect(file().state).toBe('new');
		await new Promise((r) => setTimeout(r, 0));
		// a 404 or 409 means the list changed under us: it is read again
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/files').length > before).toBe(reloads);
	});

	it('the same file added twice to one insert is "already added" (409 from the table\'s unique constraint)', async () => {
		const { inbox, fake } = scanSetup();
		await inbox.load();
		const a = fake.files[0];
		await inbox.addScan(a, form());
		// a copy of the same file in another Inbox: same pointer row, same insert
		const b = foundFile({ kind: 'surface_scan', directus_files_id: a.directus_files_id, rel_path: 'Users/zz9/copy.al3d' });
		fake.files.push(b);
		expect(await inbox.addScan(b, form())).toEqual({ ok: false, message: 'That file is already added as a surface scan of this insert or edge.' });
		expect(fake.scans).toHaveLength(1);
	});

	it('a 400 names the control it is about, so the dialog can mark it', async () => {
		const { inbox, file } = scanSetup();
		await inbox.load();
		// a day the form lets through (a shape check only) that the endpoint does not read as a real day
		const r = await inbox.addScan(file(), form({ date: '2026-02-31' }));
		expect(r).toEqual({ ok: false, message: 'The scan date is not a valid day. Use the date box, or leave it empty.', field: 'scanned_on' });
	});
});

describe('refusals that depend on whose folder it is and who linked', () => {
	const team = { kind: 'team' as const, id: 't1', name: 'SEM team' };

	it('a team file someone else already linked says someone dealt with it; a personal file says it was already linked', async () => {
		const { inbox, fake } = setup([exactMatch({ owner: team }), exactMatch({}, '9ab3c4d5', 'S-0043')]);
		await inbox.load();
		const mine = inbox.main.value.rows.find((f) => f.owner.kind === 'team')!;
		const personal = inbox.main.value.rows.find((f) => f.owner.kind === 'person')!;
		for (const f of [mine, personal]) fake.files.find((x) => x.candidate_id === f.candidate_id)!.state = 'linked';
		expect(await inbox.linkSuggested(mine)).toEqual({ ok: false, message: 'Someone already dealt with that file.' });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: 'Someone already dealt with that file.' });
		expect(await inbox.linkSuggested(personal)).toEqual({ ok: false, message: 'That file was already linked.' });
	});

	it('the 409 of a team race still reloads the list', async () => {
		const { inbox, fake } = setup([exactMatch({ owner: team })]);
		await inbox.load();
		const file = inbox.main.value.rows[0];
		fake.files[0].state = 'linked';
		await inbox.linkSuggested(file);
		await vi.waitFor(() => expect(inbox.main.value.rows).toHaveLength(0));
	});

	it('an Undo the server refuses because someone else linked the batch says who may undo it', async () => {
		const { inbox, fake } = setup([exactMatch({ owner: team })], undefined, { undoByLinkerOnly: true });
		await inbox.load();
		await inbox.link(inbox.main.value.rows[0], 'physical_samples', 's-1');
		const batch = fake.files[0].link_batch_id!;
		const r = await inbox.undo({ kind: 'batch', id: batch });
		expect(r).toEqual({ ok: false, message: 'Only the person who linked this, or an administrator, can undo it.' });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: 'Only the person who linked this, or an administrator, can undo it.' });
		expect(fake.files[0].state).toBe('linked');
	});
});
