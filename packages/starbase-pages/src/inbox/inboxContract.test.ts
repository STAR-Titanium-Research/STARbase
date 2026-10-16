// The client half of the Inbox contract test (the server half is core/extensions/d1-inbox/index.contract.test.mjs).
//
// tests/fixtures/d1-inbox/*.json are what d1-inbox answers, written by its real shaping code (core/extensions/d1-inbox/contract_fixtures.mjs). This
// test feeds EVERY one of them through the client (inboxApi.ts, @d1/ui's parseSummary, the models, createInbox / createInboxAdmin / createAutoLink)
// and asserts what the UI relies on, so the server changing a shape fails here once its fixtures are regenerated, and the client changing what it
// sends or reads fails here too. It replays the fixtures; it does not import the server, and it does not use fakeInboxServer.ts (that fake is the
// client's own idea of the server, which is how the two sides drifted once).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { badgeText, parseSummary, recordRoute, type HostApi } from '@d1/ui';
import { inboxLines } from '../home/inboxPanel';
import {
	InboxApiError, acceptAll, dismissFiles, filesParams, linkFiles, loadAdmin, loadFiles, loadPrefs, loadSummary, parseFile, rescan, restoreFiles, savePrefs, scanAll, undoBatch,
	type FilesQuery, type FoundFile,
} from './inboxApi';
import {
	AUTO_LINK_TITLE, acceptConfirmText, acceptFilter, acceptPairs, batchTitle, batchesOf, groupLinked, isAcceptable, rateLimitMessage, skippedText, RESCAN_QUEUED_TEXT,
} from './inboxBulk';
import { daemonView, adminFacts, aliasRows, isOnline, scanState, unmatchedRows } from './adminView';
import {
	DEFAULT_FILTERS, KIND_FILTER_ITEMS, STRENGTH_FILTER_ITEMS, TABS, canChange, duplicateText, extractedText, filtersToQuery, linkTarget, listPlan, needsReadNotice, ownerText, primaryAction, suggestionOf,
	type InboxFilters,
} from './inboxModel';
import { emptyScanAdd, isAddedScan, scanAddProblems, scanErrorText, scanLinkItem, scanTarget, suggestedScanItem, type ScanAddForm, type ScanItemOption } from './inboxScan';
import { createAutoLink, RECENT_LIMIT } from './useAutoLink';
import { createInbox } from './useInbox';
import { createInboxAdmin } from './useInboxAdmin';

// ---- the fixtures and a client that replays them ----------------------------------------------------------------------------------

const DIR = fileURLToPath(new URL('../../../../tests/fixtures/d1-inbox/', import.meta.url));
interface Fixture {
	description: string;
	request: { method: string; path: string; query?: Record<string, string>; body?: any };
	status: number;
	body: any;
}
const used = new Set<string>();
const fx = (name: string): Fixture => {
	used.add(name);
	return JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
};
const side = (name: string): any => {
	used.add(name);
	return JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
};
const FIXTURE_NAMES = readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')).sort();

interface Call {
	method: string;
	path: string;
	params?: Record<string, unknown>;
	body?: any;
}
type Route = Fixture | ((call: Call) => Fixture);

/** An axios-shaped client that answers each "METHOD /path" with the fixture it is given (an error status rejects like axios). */
function replay(routes: Record<string, Route>) {
	const calls: Call[] = [];
	const answer = async (method: string, path: string, params?: Record<string, unknown>, body?: any) => {
		const call: Call = { method, path, params, body };
		calls.push(call);
		const route = routes[`${method} ${path}`];
		if (!route) throw new Error(`the test has no fixture for ${method} ${path}`);
		const f = typeof route === 'function' ? route(call) : route;
		if (f.status >= 400) throw Object.assign(new Error(`Request failed with status code ${f.status}`), { response: { status: f.status, data: f.body } });
		return { data: f.body };
	};
	const api: HostApi = {
		get: (path, config) => answer('GET', path, config?.params),
		post: (path, body) => answer('POST', path, undefined, body),
		put: (path, body) => answer('PUT', path, undefined, body),
		patch: (path, body) => answer('PATCH', path, undefined, body),
		delete: (path) => answer('DELETE', path),
	};
	return { api, calls };
}
const only = (f: Fixture) => replay({ [`${f.request.method} ${f.request.path}`]: f });
const stringified = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)]));

const ids = (rows: FoundFile[]) => rows.map((r) => r.candidate_id);
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BATCH = ID(901);

// ---- GET /files -------------------------------------------------------------------------------------------------------------------

const FILE_FIXTURES = ['files_new', 'files_new_acceptable', 'files_older', 'files_linked', 'files_dismissed', 'files_team_folder', 'files_empty'];

/** The keys a parsed row has: every key the fixture row sends (`suggested_can_edit` only when the client keeps it). */
const expectedKeys = (r: Record<string, unknown>, parsed: Record<string, unknown>): string[] =>
	Object.keys(r).filter((k) => k !== 'suggested_can_edit' || 'suggested_can_edit' in parsed).sort();

describe('GET /d1-inbox/files', () => {
	it.each(FILE_FIXTURES)('%s: every row parses, key for key, and the page is read', async (name) => {
		const f = fx(name);
		const raw: any[] = f.body.data;
		const { api } = only(f);
		const page = await loadFiles(api, f.request.query as FilesQuery);
		expect(ids(page.rows)).toEqual(raw.map((r) => r.candidate_id));
		expect(page.total).toBe(f.body.meta.total);
		expect(page.acceptable).toBe(f.body.meta.acceptable);
		raw.forEach((r, i) => {
			const parsed: any = page.rows[i];
			// the client reads every key the server sends (a renamed key shows up as one the client never looks at) ...
			expect(Object.keys(parsed).sort(), r.candidate_id).toEqual(expectedKeys(r, parsed));
			// ... and gets the same value out of it (the owner is reshaped, the rest is as sent)
			for (const k of Object.keys(r)) expect(parsed[k], `${r.candidate_id}.${k}`).toEqual(r[k]);
		});
	});

	it('sends the request the fixture shows: the same keys and values', async () => {
		for (const name of FILE_FIXTURES) {
			const f = fx(name);
			const { api, calls } = only(f);
			await loadFiles(api, f.request.query as FilesQuery);
			expect(calls[0]).toMatchObject({ method: 'GET', path: f.request.path });
			expect(stringified(calls[0].params)).toEqual(f.request.query);
		}
	});

	it('a new original: candidate_id, the suggestion text, the record the server named, and Link', async () => {
		const [file] = (await loadFiles(only(fx('files_new')).api, {})).rows;
		expect(file.candidate_id).toBe(ID(1001));
		expect(suggestionOf(file)).toMatchObject({ text: 'short ID `3fa9c1d2` in the file name', record: 'S-0042', weak: false, target: { collection: 'physical_samples' } });
		expect(extractedText(file.extracted)).toBe('15 kV · ×5,000 · 2 µm · JEOL');
		expect(file.suggested_can_edit).toBe(true);
		expect(primaryAction(file)).toMatchObject({ kind: 'link' });
		expect(isAcceptable(file)).toBe(true);
		expect(file.owner).toMatchObject({ kind: 'person', name: 'Alice A' });
		expect(file.name).toBe('3fa9c1d2_A1.tif');
	});

	it('a copy is flagged, says whose Inbox the original is in, and sits in a team folder', async () => {
		const rows = (await loadFiles(only(fx('files_new')).api, {})).rows;
		const copy = rows.find((r) => r.duplicate_of)!;
		expect(copy.duplicate_of).toBe(ID(1001));
		expect(duplicateText(copy)).toBe("Copy of a file in Alice A's Inbox");
		expect(copy.owner).toMatchObject({ kind: 'team', name: 'SEM team' });
		expect(ownerText(copy)).toBe('SEM team (team folder)');
		expect(rows.find((r) => r.candidate_id === ID(1001))!.duplicate_of).toBeNull();
	});

	it('a copy of a file in an Inbox the caller has nothing to do with says so without naming anyone', async () => {
		const rows = (await loadFiles(only(fx('files_team_folder')).api, { tab: 'new' })).rows;
		const other = rows.find((r) => r.candidate_id === ID(1013))!;
		expect(other.duplicate_of).toBe(ID(1001));
		expect(other.duplicate_of_owner).toEqual({ kind: 'other' });
		expect(duplicateText(other)).toBe('Copy of a file someone else also has');
		expect(JSON.stringify(other)).not.toContain('Bob B');
		expect(duplicateText(rows.find((r) => r.candidate_id === ID(1002))!)).toBe("Copy of a file in Alice A's Inbox");
	});

	it('a surface scan file named after an edge arrives with that edge suggested, so the Add dialog starts with it chosen (S4)', async () => {
		const rows = (await loadFiles(only(fx('files_new')).api, {})).rows;
		const edge = rows.find((r) => r.candidate_id === ID(1014))!;
		expect(edge.kind).toBe('surface_scan');
		expect(edge.match_strength).toBe('edge_code');
		expect(edge.suggested_collection).toBe('insert_edges');
		expect(suggestedScanItem(edge)).toEqual({ kind: 'edge', id: ID(202), label: 'H13A-#2-fC', detail: '' });
		expect(primaryAction(edge)).toEqual({ kind: 'scan', label: 'Add a surface scan' });
		// the suggestion is never an edit right, and Accept all never takes the file
		expect(edge.suggested_can_edit).toBe(false);
		expect(isAcceptable(edge)).toBe(false);
		// a scan with no name pointing anywhere has no item to start with
		expect(suggestedScanItem(rows.find((r) => r.candidate_id === ID(1003))!)).toBeNull();
	});

	it('a surface scan has Add a surface scan and no Link, a document is read once, a file the caller cannot edit asks for a record, a hidden record has no suggestion', async () => {
		const rows = (await loadFiles(only(fx('files_new')).api, {})).rows;
		const by = (n: number) => rows.find((r) => r.candidate_id === ID(n))!;
		expect(primaryAction(by(1003))).toEqual({ kind: 'scan', label: 'Add a surface scan' });
		expect(isAcceptable(by(1003))).toBe(false);
		expect(by(1004).kind).toBe('document');
		expect(needsReadNotice(by(1004).kind)).toBe(true);
		expect(suggestionOf(by(1004))).toMatchObject({ record: 'S-0042' });
		expect(by(1004).mime_type).toBe('application/pdf');
		// readable but not editable: the server says so, and Accept all would skip it
		expect(by(1005).suggested_can_edit).toBe(false);
		expect(primaryAction(by(1005))).toMatchObject({ kind: 'pick' });
		expect(isAcceptable(by(1005))).toBe(false);
		// a Restricted record the caller cannot read is not named at all, though the strength says short_id
		expect(by(1006)).toMatchObject({ match_strength: 'short_id', matches: [], suggested_record_id: null, suggested_label: null });
		expect(suggestionOf(by(1006))).toBeNull();
		expect(primaryAction(by(1006))).toMatchObject({ kind: 'pick' });
	});

	it('the Older files tab: a backlog exact match', async () => {
		const [file] = (await loadFiles(only(fx('files_older')).api, {})).rows;
		expect(file).toMatchObject({ origin: 'backlog', state: 'new', match_strength: 'short_id', suggested_label: 'S-0042' });
	});

	it('Recently linked: the batch, how it was linked, to which record', async () => {
		const rows = (await loadFiles(only(fx('files_linked')).api, {})).rows;
		const auto = rows.find((r) => r.link_kind === 'auto')!;
		expect(auto).toMatchObject({ state: 'linked', link_batch_id: BATCH, linked_collection: 'physical_samples', linked_label: 'S-0042', decided_by_name: 'Alice A' });
		expect(auto.linked_record_id).toBe(ID(101));
		expect(batchesOf(rows).map((b) => [b.id, b.count, b.kind])).toEqual(expect.arrayContaining([[BATCH, 1, 'auto']]));
		expect(batchTitle(batchesOf(rows).find((b) => b.id === BATCH)!)).toBe('Linked automatically, 1 file');
		expect(groupLinked(rows).every((g) => g.batch !== null)).toBe(true);
		expect(rows.find((r) => r.link_kind === 'manual')).toMatchObject({ adopted: true });
	});

	it('Dismissed and an empty list', async () => {
		expect((await loadFiles(only(fx('files_dismissed')).api, {})).rows[0]).toMatchObject({ state: 'dismissed', decided_by_name: 'Alice A' });
		expect(await loadFiles(only(fx('files_empty')).api, {})).toEqual({ rows: [], total: 0, acceptable: null });
	});

	it('meta.acceptable is read when the server sends it (only with acceptable=1, which the client never asks for)', async () => {
		const page = await loadFiles(only(fx('files_new_acceptable')).api, {});
		expect(page).toMatchObject({ total: 2, acceptable: 1 });
		expect(fx('files_new').body.meta.acceptable).toBeNull();
		for (const q of Object.values(listPlan(DEFAULT_FILTERS))) if (q && typeof q === 'object') expect(q).not.toHaveProperty('acceptable');
	});

	it('a refused filter is an InboxApiError with the server\'s words and code', async () => {
		const f = fx('files_400_bad_filter');
		await expect(loadFiles(only(f).api, {})).rejects.toMatchObject({ name: 'InboxApiError', status: 400, code: 'INVALID_PAYLOAD', message: f.body.errors[0].message });
	});
});

// ---- GET /summary -----------------------------------------------------------------------------------------------------------------

describe('GET /d1-inbox/summary', () => {
	it('a person with an alias and a team: the counts, the totals, the Home lines and the badge', async () => {
		const f = fx('summary_person_alias_team');
		const s = await loadSummary(only(f).api);
		// (person_id is in the answer; the client has no use for it)
		const { person_id: _unused, ...counts } = f.body.data.person;
		expect(s.person).toEqual(counts);
		expect(s.teams).toEqual(f.body.data.teams);
		expect(s.newCount).toBe(7);
		expect(s.olderMatches).toBe(3);
		// useInboxSummary hands parseSummary the whole body, not the unwrapped data
		expect(parseSummary(f.body)).toEqual(s);
		expect(badgeText(s.newCount)).toBe('7');
		const lines = inboxLines(s);
		expect(lines.map((l) => l.key)).toEqual(['me-new', 'me-older', `${ID(21)}-new`, `${ID(21)}-older`]);
		expect(lines.map((l) => l.text)).toEqual(['3 new files', '2 older files match a record', '4 new files', '1 older file matches a record']);
	});

	it('a person with no alias yet: has_alias is false and nothing is counted', async () => {
		const s = await loadSummary(only(fx('summary_person_no_alias')).api);
		expect(s.person).toEqual({ new: 0, older_matches: 0, has_alias: false });
		expect(s.teams).toEqual([]);
		expect(s.newCount).toBe(0);
	});

	it('a login with no People row: no person block, still a summary', async () => {
		const s = await loadSummary(only(fx('summary_no_person')).api);
		expect(s).toMatchObject({ person: null, teams: [], newCount: 0, olderMatches: 0 });
	});
});

// ---- POST /link, /dismiss, /restore, /undo ----------------------------------------------------------------------------------------

describe('link, dismiss, restore, undo', () => {
	it('link: the request is the fixture\'s, the answer gives the batch and the junction rows', async () => {
		for (const name of ['link_ok', 'link_ok_bulk']) {
			const f = fx(name);
			const { api, calls } = only(f);
			const r = await linkFiles(api, f.request.body.items);
			expect(calls[0].body).toEqual(f.request.body);
			expect(r.link_batch_id).toBe(f.body.data.link_batch_id);
			expect(r.linked).toBe(f.body.data.linked);
			expect(r.items).toEqual(f.body.data.items);
		}
		expect((await linkFiles(only(fx('link_ok_bulk')).api, [])).items[1]).toMatchObject({ adopted: true });
	});

	it('link repeated by the same person: nothing new, no batch (so no Undo), the row marked already linked', async () => {
		const r = await linkFiles(only(fx('link_already_linked')).api, []);
		expect(r).toMatchObject({ link_batch_id: '', linked: 0 });
		expect(r.items[0]).toMatchObject({ already_linked: true });
	});

	it.each([
		['link_403_not_editable', 403, 'FORBIDDEN'],
		['link_409_already_linked', 409, 'ALREADY_LINKED'],
		['link_409_already_on_record', 409, 'ALREADY_ON_RECORD'],
		['link_409_surface_scan', 409, 'SURFACE_SCAN'],
		['error_401', 401, 'UNAUTHORIZED'],
		['error_403_read_only', 403, 'READ_ONLY_ROLE'],
		['error_500', 500, 'INTERNAL_SERVER_ERROR'],
		['dismiss_409_not_new', 409, 'NOT_NEW'],
		['undo_404', 404, 'NOT_FOUND'],
	])('%s throws an InboxApiError with status, code, extensions and the server\'s message', async (name, status, code) => {
		const f = fx(name);
		const e: any = await (f.request.path.endsWith('/link') ? linkFiles(only(f).api, f.request.body.items)
			: f.request.path.endsWith('/dismiss') ? dismissFiles(only(f).api, f.request.body.candidate_ids)
				: f.request.path.endsWith('/undo') ? undoBatch(only(f).api, BATCH)
					: loadSummary(only(f).api)).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e).toMatchObject({ status, code, message: f.body.errors[0].message });
		expect(e.extensions).toMatchObject({ source: 'd1-inbox', code });
	});

	it('a 403 and a 409 name the file in extensions, which a page can act on', async () => {
		const e: any = await linkFiles(only(fx('link_403_not_editable')).api, []).catch((x) => x);
		expect(e.extensions).toMatchObject({ candidate_id: ID(1001), collection: 'physical_samples', record_id: ID(101) });
		const g: any = await linkFiles(only(fx('link_409_already_linked')).api, []).catch((x) => x);
		expect(g.extensions.candidate_id).toBe(ID(1001));
	});

	it('dismiss and restore answer how many changed; the request is the fixture\'s', async () => {
		const d = fx('dismiss_ok');
		const dc = only(d);
		expect(await dismissFiles(dc.api, d.request.body.candidate_ids)).toBe(1);
		expect(dc.calls[0].body).toEqual(d.request.body);
		const r = fx('restore_ok');
		const rc = only(r);
		expect(await restoreFiles(rc.api, r.request.body.candidate_ids)).toBe(1);
		expect(rc.calls[0].body).toEqual(r.request.body);
	});

	it('undo answers how many files are back in the Inbox', async () => {
		const f = fx('undo_ok');
		const { api, calls } = only(f);
		expect(await undoBatch(api, BATCH)).toBe(2);
		expect(calls[0].body).toEqual(f.request.body);
	});
});

// ---- POST /accept-all -------------------------------------------------------------------------------------------------------------

const FILTER: InboxFilters = { ...DEFAULT_FILTERS };

describe('POST /d1-inbox/accept-all', () => {
	it('the dry run: the count, the ids Confirm will send, what is left and why, and that nothing was linked', async () => {
		const f = fx('accept_all_dry_run');
		const { api, calls } = only(f);
		const r = await acceptAll(api, acceptFilter(FILTER), { dryRun: true });
		expect(calls[0].body).toEqual(f.request.body);
		expect(r).toMatchObject({ dry_run: true, acceptable: 2, linked: 0, link_batch_id: '', has_more: false, ids: [ID(1001), ID(1011)], items: [], skippedTotal: 2 });
		expect(r.skipped).toEqual(f.body.data.skipped);
		expect(skippedText(r.skipped, r.skippedTotal)).toBe('Left for you to decide: 2 files whose record you cannot edit.');
		// the ids are the whole count, which is what makes the client trust them
		expect(r.ids.length).toBe(r.acceptable);
	});

	it('a dry run that stopped at its page cap says has_more (the confirm warns)', async () => {
		const r = await acceptAll(only(fx('accept_all_dry_run_has_more')).api, acceptFilter(FILTER), { dryRun: true });
		expect(r).toMatchObject({ has_more: true, acceptable: 2 });
		expect(acceptConfirmText({ count: r.acceptable, hasMore: r.has_more, mayRead: false })).toContain('More files match than one run takes');
	});

	it('a dry run with nothing to link', async () => {
		const r = await acceptAll(only(fx('accept_all_dry_run_none')).api, acceptFilter(FILTER), { dryRun: true });
		expect(r).toMatchObject({ dry_run: true, acceptable: 0, ids: [], has_more: false });
		expect(r.skipped).toHaveLength(2);
	});

	it('the page\'s own estimate of what Accept all links is the endpoint\'s answer for the same rows (a copy, a surface scan and a file it cannot edit are not counted)', async () => {
		const rows = (await loadFiles(only(fx('files_new')).api, {})).rows;
		const dry = await acceptAll(only(fx('accept_all_dry_run')).api, acceptFilter(FILTER), { dryRun: true });
		expect(ids(rows.filter(isAcceptable))).toEqual(dry.ids);
		expect(dry.ids).not.toContain(ID(1002));
	});

	it('the endpoint names at most 200 of the files it left: skipped_total is the whole count and the text says how many are not listed', async () => {
		const f = fx('accept_all_real');
		const body = { data: { ...f.body.data, skipped_total: 250 } };
		const r = await acceptAll(only({ ...f, body }).api, acceptFilter(FILTER));
		expect(r.skippedTotal).toBe(250);
		expect(skippedText(r.skipped, r.skippedTotal)).toBe('Left for you to decide: 2 files whose record you cannot edit. 248 more are not listed.');
		// an answer that leaves it out (an older draft) counts the listed ones
		const bare = { data: { ...f.body.data } };
		delete (bare.data as any).skipped_total;
		expect((await acceptAll(only({ ...f, body: bare }).api, acceptFilter(FILTER))).skippedTotal).toBe(2);
	});

	it('the real run: the batch Undo works on, the count, the items, what was left', async () => {
		const f = fx('accept_all_real');
		const { api, calls } = only(f);
		const r = await acceptAll(api, acceptFilter(FILTER));
		expect(calls[0].body).toEqual(f.request.body);
		expect(r).toMatchObject({ link_batch_id: BATCH, linked: 2, dry_run: false, has_more: false, acceptable: 2 });
		expect(r.items).toEqual(f.body.data.items);
		expect(r.items[1]).toMatchObject({ candidate_id: ID(1011), adopted: true });
		expect(r.ids).toEqual([ID(1001), ID(1011)]);
		expect(r.skipped).toHaveLength(2);
	});

	it('the real run for exactly the previewed files sends candidate_ids and nothing else new', async () => {
		const f = fx('accept_all_real_candidate_ids');
		const { api, calls } = only(f);
		const r = await acceptAll(api, acceptFilter(FILTER), { candidateIds: f.request.body.candidate_ids });
		expect(calls[0].body).toEqual(f.request.body);
		expect(r).toMatchObject({ link_batch_id: BATCH, linked: 2 });
	});

	it('a real run that linked nothing has no batch and so no Undo', async () => {
		const r = await acceptAll(only(fx('accept_all_real_none')).api, acceptFilter(FILTER));
		expect(r).toMatchObject({ link_batch_id: '', linked: 0, items: [] });
		expect(r.skipped.length).toBeGreaterThan(0);
	});
});

// ---- the Inbox page's state over the fixtures -------------------------------------------------------------------------------------

describe('the Inbox page (createInbox) against the fixtures', () => {
	const files = fx('files_new');
	function page(extra: Record<string, Route> = {}) {
		const r = replay({
			'GET /d1-inbox/files': files,
			'POST /d1-inbox/link': fx('link_ok'),
			'POST /d1-inbox/dismiss': fx('dismiss_ok'),
			'POST /d1-inbox/restore': fx('restore_ok'),
			'POST /d1-inbox/undo': fx('undo_ok'),
			'POST /d1-inbox/rescan': fx('rescan_202'),
			'POST /d1-inbox/accept-all': ({ body }) => (body.dry_run ? fx('accept_all_dry_run') : body.candidate_ids ? fx('accept_all_real_candidate_ids') : fx('accept_all_real')),
			...extra,
		});
		const inbox = createInbox({ api: r.api, getFilters: () => FILTER });
		return { ...r, inbox };
	}

	it('Link on a suggested file sends the fixture\'s request and offers one Undo for the batch', async () => {
		const { inbox, calls } = page();
		await inbox.load();
		const file = inbox.main.value.rows.find((r) => r.candidate_id === ID(1001))!;
		expect(await inbox.linkSuggested(file)).toEqual({ ok: true });
		const sent = calls.find((c) => c.method === 'POST' && c.path === '/d1-inbox/link')!;
		expect(sent.body).toEqual(fx('link_ok').request.body);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Linked 1 found file.', undo: { kind: 'batch', id: BATCH } });
		await inbox.undo(inbox.notice.value!.undo!);
		expect(calls.find((c) => c.path === '/d1-inbox/undo')!.body).toEqual({ link_batch_id: BATCH });
		expect(inbox.notice.value?.text).toBe('Undone: 2 found files back in your Inbox.');
	});

	it('Link repeated says it was already linked and offers no Undo (the server made no batch)', async () => {
		const { inbox } = page({ 'POST /d1-inbox/link': fx('link_already_linked') });
		await inbox.load();
		await inbox.linkSuggested(inbox.main.value.rows.find((r) => r.candidate_id === ID(1001))!);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'That file was already linked.' });
		expect(inbox.notice.value?.undo).toBeUndefined();
	});

	it('a refused Link shows the server\'s own words; a 409 reloads the list', async () => {
		const forbidden = page({ 'POST /d1-inbox/link': fx('link_403_not_editable') });
		await forbidden.inbox.load();
		const outcome = await forbidden.inbox.linkSuggested(forbidden.inbox.main.value.rows.find((r) => r.candidate_id === ID(1001))!);
		expect(outcome).toEqual({ ok: false, message: fx('link_403_not_editable').body.errors[0].message });
		expect(forbidden.inbox.notice.value).toMatchObject({ tone: 'bad', text: fx('link_403_not_editable').body.errors[0].message });
		const conflict = page({ 'POST /d1-inbox/link': fx('link_409_already_linked') });
		await conflict.inbox.load();
		const before = conflict.calls.filter((c) => c.path === '/d1-inbox/files').length;
		await conflict.inbox.linkSuggested(conflict.inbox.main.value.rows.find((r) => r.candidate_id === ID(1001))!);
		await new Promise((r) => setTimeout(r, 0));
		expect(conflict.calls.filter((c) => c.path === '/d1-inbox/files').length).toBeGreaterThan(before);
	});

	it('Dismiss offers a Restore of that file', async () => {
		const { inbox, calls } = page();
		await inbox.load();
		await inbox.dismiss(inbox.main.value.rows[0]);
		expect(calls.find((c) => c.path === '/d1-inbox/dismiss')!.body).toEqual({ candidate_ids: [ID(1001)] });
		expect(inbox.notice.value?.undo).toEqual({ kind: 'restore', ids: [ID(1001)] });
	});

	it('Accept all: the dry run, the confirm from it, the real run for exactly those files, one Undo for the batch', async () => {
		const { inbox, calls } = page();
		await inbox.load();
		expect(inbox.canAcceptAll.value).toBe(true);
		await inbox.openAccept();
		const d = inbox.acceptDialog.value;
		expect(calls.find((c) => c.path === '/d1-inbox/accept-all')!.body).toEqual(fx('accept_all_dry_run').request.body);
		expect(d).toMatchObject({ open: true, loading: false, error: '', count: 2, hasMore: false, ids: [ID(1001), ID(1011)], pairsExact: true, skippedTotal: 2 });
		expect(d.skipped.map((s) => s.reason)).toEqual(['NOT_EDITABLE', 'NOT_EDITABLE']);
		expect(d.pairs).toEqual([{ file: '3fa9c1d2_A1.tif', record: 'S-0042' }, { file: '3fa9c1d2_report.pdf', record: 'S-0042' }]);
		expect(await inbox.confirmAccept()).toEqual({ ok: true });
		const real = calls.filter((c) => c.path === '/d1-inbox/accept-all')[1];
		expect(real.body).toEqual(fx('accept_all_real_candidate_ids').request.body);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'Linked 2 found files.', undo: { kind: 'batch', id: BATCH } });
	});

	it('Accept all with nothing to link keeps Confirm off', async () => {
		const { inbox, calls } = page({ 'POST /d1-inbox/accept-all': fx('accept_all_dry_run_none') });
		await inbox.load();
		await inbox.openAccept();
		expect(inbox.acceptDialog.value).toMatchObject({ count: 0, ids: null });
		expect(await inbox.confirmAccept()).toMatchObject({ ok: false });
		expect(calls.filter((c) => c.path === '/d1-inbox/accept-all')).toHaveLength(1);
	});

	it('Accept all that stopped at its cap warns that more files match', async () => {
		const { inbox } = page({ 'POST /d1-inbox/accept-all': fx('accept_all_dry_run_has_more') });
		await inbox.load();
		await inbox.openAccept();
		expect(inbox.acceptDialog.value).toMatchObject({ count: 2, hasMore: true });
	});

	it('a real Accept all that links nothing says so and offers no Undo', async () => {
		const { inbox } = page({ 'POST /d1-inbox/accept-all': ({ body }) => (body.dry_run ? fx('accept_all_dry_run') : fx('accept_all_real_none')) });
		await inbox.load();
		await inbox.openAccept();
		await inbox.confirmAccept();
		expect(inbox.notice.value).toMatchObject({ tone: 'warn' });
		expect(inbox.notice.value?.undo).toBeUndefined();
	});

	it('Rescan: queued, the 10-minute limit says when to try again, and no folder is a refusal in the server\'s words', async () => {
		const ok = page();
		await ok.inbox.rescanNow();
		expect(ok.inbox.notice.value?.text).toBe(RESCAN_QUEUED_TEXT);
		const limited = page({ 'POST /d1-inbox/rescan': fx('rescan_429') });
		const out = await limited.inbox.rescanNow();
		expect(out).toEqual({ ok: false, message: rateLimitMessage(420) });
		expect(limited.inbox.notice.value).toMatchObject({ tone: 'warn', text: expect.stringContaining('Try again in 7 minutes') });
		const none = page({ 'POST /d1-inbox/rescan': fx('rescan_409_no_folder') });
		expect(await none.inbox.rescanNow()).toEqual({ ok: false, message: fx('rescan_409_no_folder').body.errors[0].message });
	});

	it('the rescan calls are the fixtures\' requests', async () => {
		for (const name of ['rescan_202', 'rescan_429', 'rescan_409_no_folder']) {
			const f = fx(name);
			const { api, calls } = only(f);
			await rescan(api).catch(() => undefined);
			expect(calls[0]).toMatchObject({ method: f.request.method, path: f.request.path, body: f.request.body });
		}
		const e: any = await rescan(only(fx('rescan_429')).api).catch((x) => x);
		expect(e).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
		expect(e.extensions.retry_after_seconds).toBe(420);
		expect(((await rescan(only(fx('rescan_409_no_folder')).api).catch((x) => x)) as any).code).toBe('NO_FOLDER');
	});
});

// ---- prefs, auto-link ---------------------------------------------------------------------------------------------------------------

describe('prefs and Recently auto-linked', () => {
	it('prefs: read off, saved on with the fixture\'s PUT body', async () => {
		expect(await loadPrefs(only(fx('prefs_get_off')).api)).toEqual({ auto_link: false });
		const f = fx('prefs_put_on');
		const { api, calls } = only(f);
		expect(await savePrefs(api, { auto_link: true })).toEqual({ auto_link: true });
		expect(calls[0]).toMatchObject({ method: 'PUT', path: f.request.path });
		expect(calls[0].body).toEqual(f.request.body);
	});

	it('the Settings section loads the switch and the auto-linked list the way the fixtures ask for it', async () => {
		const files = fx('files_linked');
		const { api, calls } = replay({ 'GET /d1-inbox/prefs': fx('prefs_get_off'), 'GET /d1-inbox/files': files, 'PUT /d1-inbox/prefs': fx('prefs_put_on'), 'POST /d1-inbox/undo': fx('undo_ok') });
		const s = createAutoLink(api);
		await s.load();
		expect(s.on.value).toBe(false);
		expect(s.recent.value.map((f) => f.link_batch_id)).toEqual([BATCH, ID(902)]);
		expect(stringified(calls.find((c) => c.path === '/d1-inbox/files')!.params)).toEqual({ tab: 'linked', link_kind: 'auto', limit: String(RECENT_LIMIT) });
		expect(RECENT_LIMIT).toBe(Number(files.request.query!.limit));
		expect(await s.set(true)).toBe(true);
		expect(s.on.value).toBe(true);
		await s.undo(BATCH);
		expect(s.note.value).toBe('Undone: 2 found files back in your Inbox.');
		expect(AUTO_LINK_TITLE).toBeTruthy();
	});
});

// ---- the admin tab -------------------------------------------------------------------------------------------------------------------

describe('GET /d1-inbox/admin', () => {
	const VERDICT: Record<string, [string, string, boolean]> = {
		admin_alive: ['alive', 'Online, running', true],
		admin_paused: ['paused', 'Online, paused', true],
		admin_stale: ['stale', 'Offline', false],
		admin_never: ['never', 'Not started yet', false],
	};
	it.each(Object.keys(VERDICT))('%s: the server\'s verdict is the one shown', async (name) => {
		const [daemon, label, online] = VERDICT[name];
		const f = fx(name);
		const a = await loadAdmin(only(f).api);
		expect(a.status.daemon).toBe(daemon);
		expect(daemonView(a.status, Date.parse('2026-10-15T12:00:00Z')).label).toBe(label);
		expect(isOnline(a.status, Date.parse('2026-10-15T12:00:00Z'))).toBe(online);
		// the page shows the queue, the unmatched folders, the people with no alias and the candidates as the server counted them
		expect(a.queue).toEqual({ queued: 1, running: 0 });
		expect(a.queued_requests).toBe(1);
		expect(a.candidates).toEqual({ new: 5, linked: 2, dismissed: 1 });
		expect(a.people_without_alias).toEqual(f.body.data.people_without_alias);
		expect(aliasRows(a.people_without_alias).map((r) => [r.name, r.note])).toEqual([['Dave D', ''], ['Fay Former', 'Former, no login yet']]);
		expect(a.errors.map((e) => e.message)).toEqual(f.body.data.errors.map((e: any) => e.message));
		expect(a.errors.every((e) => e.at !== null || name === 'admin_never')).toBe(true);
		expect(a.status.last_error).toBe(f.body.data.status.last_error);
	});

	it('a running daemon: every status field arrives as the page reads it', async () => {
		const f = fx('admin_alive');
		const a = await loadAdmin(only(f).api);
		// read_mb_per_s is the daemon's read throttle: sent, and not shown on the page
		const { read_mb_per_s: _throttle, ...shown } = f.body.data.status;
		expect(a.status).toEqual(shown);
		expect(a.status).toMatchObject({ desired_state: 'running', interval_minutes: 30, files_registered: 42, error_count: 1, current_activity: 'idle' });
		expect(a.unmatched_folders).toEqual(['Users/zz9', 'Shared/Old project']);
		expect(unmatchedRows(a.unmatched_folders).map((r) => r.area)).toEqual(['Users', 'Shared']);
		expect(adminFacts(a.status).find((x) => x.label === 'Files registered')!.value).toBe('42');
		expect(scanState(a.status, Date.parse('2026-10-15T12:00:00Z'))).toBe('done');
	});

	it('a daemon that never started: no heartbeat, nothing to show but zeroes', async () => {
		const a = await loadAdmin(only(fx('admin_never')).api);
		expect(a.status).toMatchObject({ daemon: 'never', last_heartbeat_at: null, desired_state: null, files_registered: 0 });
	});

	it('a person who is not an administrator is refused, and the tab says so', async () => {
		const f = fx('admin_403');
		await expect(loadAdmin(only(f).api)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
		const s = createInboxAdmin(only(f).api);
		await s.load();
		expect(s.missing.value).toBe('not-admin');
	});

	it('Scan all: queued (202), and already waiting (409) in the server\'s words', async () => {
		const ok = fx('scan_all_202');
		const { api, calls } = replay({ 'GET /d1-inbox/admin': fx('admin_alive'), 'POST /d1-inbox/admin/scan-all': ok });
		const s = createInboxAdmin(api);
		await s.load();
		expect(await s.scanAllNow()).toBe(true);
		expect(calls.find((c) => c.method === 'POST')!.body).toEqual(ok.request.body);
		const busy = fx('scan_all_409_already_queued');
		const b = createInboxAdmin(replay({ 'GET /d1-inbox/admin': fx('admin_alive'), 'POST /d1-inbox/admin/scan-all': busy }).api);
		await b.load();
		expect(await b.scanAllNow()).toBe(false);
		expect(b.actionError.value).toBe(busy.body.errors[0].message);
		await expect(scanAll(only(busy).api)).rejects.toMatchObject({ status: 409, code: 'ALREADY_QUEUED' });
		await expect(scanAll(only(ok).api)).resolves.toBeUndefined();
	});
});

// ---- the query side: what the client asks for must be what the server reads ---------------------------------------------------

describe('the client sends only filters the server reads', () => {
	const keys = side('filter_keys') as { keys: string[]; values: Record<string, string[]>; owner_forms: string[]; limit: { default: number; max: number } };
	const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const DAY = /^\d{4}-\d{2}-\d{2}$/;

	/** Why the server would ignore or refuse this query ('' when it reads all of it). */
	function problems(q: Record<string, unknown>): string[] {
		const out: string[] = [];
		for (const [k, v] of Object.entries(q)) {
			if (!keys.keys.includes(k)) {
				out.push(`${k}: the server ignores this key`);
				continue;
			}
			const text = String(v);
			if (keys.values[k]) {
				for (const part of text.split(',')) if (!keys.values[k].includes(part)) out.push(`${k}=${part}: not one of ${keys.values[k].join('|')}`);
			} else if (k === 'owner') {
				const m = /^(me|team|person)(?::(.+))?$/.exec(text);
				if (!m || (m[1] === 'me') !== (m[2] === undefined) || (m[2] !== undefined && !UUIDISH.test(m[2]))) out.push(`owner=${text}: not ${keys.owner_forms.join(' | ')}`);
			} else if (k === 'from' || k === 'to') {
				if (!DAY.test(text)) out.push(`${k}=${text}: not a day`);
			} else if (k === 'limit') {
				if (!(Number(text) >= 1 && Number(text) <= keys.limit.max)) out.push(`limit=${text}: outside 1..${keys.limit.max}`);
			} else if (k === 'offset') {
				if (!(Number(text) >= 0)) out.push(`offset=${text}: negative`);
			} else if (k === 'folder' && text === '') out.push('folder: empty (the client leaves it out)');
		}
		return out;
	}

	it('the check itself bites: a key the server ignores, and a value it refuses, are found', () => {
		expect(problems({ tab: 'new', page: 2 })).toEqual(['page: the server ignores this key']);
		expect(problems({ search: 'x' })).toHaveLength(1);
		expect(problems({ kind: 'sem_image,video' })).toEqual([expect.stringContaining('video')]);
		expect(problems({ owner: 'team:nope' })).toHaveLength(1);
		expect(problems({ tab: 'open', kind: 'image', strength: 'short_id', folder: 'sem', from: '2026-10-01', to: '2026-10-15', owner: 'me', link_kind: 'auto', limit: 50, offset: 0 })).toEqual([]);
	});

	const TEAM = `team:${ID(21)}`;
	const combos: InboxFilters[] = [];
	for (const tab of TABS.map((t) => t.id)) {
		for (const kind of KIND_FILTER_ITEMS.map((i) => i.value)) {
			for (const strength of STRENGTH_FILTER_ITEMS.map((i) => i.value)) {
				for (const owner of ['any', 'me', TEAM]) {
					combos.push({ tab, kind, strength, owner, folder: '', from: '', to: '' });
					combos.push({ tab, kind, strength, owner, folder: 'sem', from: '2026-10-01', to: '2026-10-15' });
				}
			}
		}
	}

	it('listPlan (both requests, every page), acceptFilter and filtersToQuery only use keys and values the server reads', () => {
		let checked = 0;
		for (const f of combos) {
			const plan = listPlan(f, 0);
			const next = listPlan(f, 3);
			for (const q of [plan.main, plan.other, next.main, next.other]) {
				if (!q) continue;
				expect(problems(filesParams(q)), JSON.stringify(f)).toEqual([]);
				checked += 1;
			}
			expect(problems(filesParams(acceptFilter(f))), JSON.stringify(f)).toEqual([]);
			expect(problems(filtersToQuery(f)), JSON.stringify(f)).toEqual([]);
		}
		expect(checked).toBeGreaterThan(1000);
		expect(listPlan(DEFAULT_FILTERS).main!.limit).toBeLessThanOrEqual(keys.limit.max);
	});

	it('the tabs the page has are tabs the server has', () => {
		for (const t of TABS) expect(keys.values.tab).toContain(t.id);
		for (const k of KIND_FILTER_ITEMS.map((i) => i.value).filter((v) => v !== 'any')) expect(keys.values.kind).toContain(k);
		for (const s of STRENGTH_FILTER_ITEMS.map((i) => i.value).filter((v) => v !== 'any').flatMap((v) => v.split(','))) expect(keys.values.strength).toContain(s);
	});

	it('the Home panel, the Home target and the tab links go to addresses whose filters the server reads', async () => {
		const s = await loadSummary(only(fx('summary_person_alias_team')).api);
		const urls = [...inboxLines(s).map((l) => l.to), '/inbox', '/inbox?tab=older'];
		for (const u of urls) expect(problems(Object.fromEntries(new URL(u, 'http://x').searchParams)), u).toEqual([]);
		for (const t of TABS) {
			const q = new URLSearchParams(filtersToQuery({ ...DEFAULT_FILTERS, tab: t.id }));
			expect(problems(Object.fromEntries(q))).toEqual([]);
		}
	});

	it('every literal /inbox? link in the sources uses keys the server reads', () => {
		const roots = [fileURLToPath(new URL('../', import.meta.url)), fileURLToPath(new URL('../../../d1-ui/src/', import.meta.url))];
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const n of readdirSync(dir)) {
				const p = `${dir}${dir.endsWith('/') ? '' : '/'}${n}`;
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|vue)$/.test(n) && !/\.test\.ts$/.test(n) && !/fakeInboxServer/.test(n)) {
					for (const m of readFileSync(p, 'utf8').matchAll(/\/inbox\?([^"'`\s)<>]*)/g)) found.push(m[1].replace(/\$\{[^}]*\}/g, '$T'));
				}
			}
		};
		roots.forEach(walk);
		expect(found.length).toBeGreaterThan(3);
		for (const query of found) {
			// a name built from a template (`owner=team:${...}`) is a value, not a key; the computed addresses are checked above
			const names = query.split('&').map((p) => p.split('=')[0]).filter((n) => n && !n.includes('$'));
			expect(names.filter((k) => !keys.keys.includes(k)), `/inbox?${query}`).toEqual([]);
		}
	});

	it('the queries the server\'s own parse cases use are read by the same key list (filters_parse)', () => {
		for (const c of side('filters_parse').cases) expect(problems(Object.fromEntries(Object.entries(c.query).filter(([k]) => k !== 'limit'))), JSON.stringify(c.query)).toEqual([]);
	});

	it('the file-list queries the client builds elsewhere (Recently auto-linked) are read too', () => {
		expect(problems({ tab: 'linked', link_kind: 'auto', limit: RECENT_LIMIT })).toEqual([]);
	});
});

// ---- adding a surface scan (stream F2): POST /link with a surface_scans item, its refusals, its undo, the Recently linked row ------------

describe('adding a surface scan', () => {
	const INSERT = ID(201);
	const EDGE = ID(202);
	const OP = ID(102);
	const SCAN = ID(1003);
	const SCAN_ID = ID(6001);
	const insert: ScanItemOption = { kind: 'insert', id: INSERT, label: 'H13A-#2', detail: '' };
	const edge: ScanItemOption = { kind: 'edge', id: EDGE, label: 'H13A-#2-fC', detail: '' };
	const worn = (): ScanAddForm => ({ ...emptyScanAdd(insert), condition: 'worn' });

	function page(link: Fixture, extra: Record<string, Route> = {}) {
		const r = replay({
			'GET /d1-inbox/files': fx('files_new'),
			'POST /d1-inbox/link': link,
			'POST /d1-inbox/undo': fx('undo_ok_surface_scan'),
			...extra,
		});
		const inbox = createInbox({ api: r.api, getFilters: () => FILTER });
		return { ...r, inbox };
	}
	const scanRow = (inbox: ReturnType<typeof createInbox>) => inbox.main.value.rows.find((r) => r.candidate_id === SCAN)!;
	const sent = (calls: Call[]) => calls.filter((c) => c.path === '/d1-inbox/link');

	it('the surface scan row of the New tab has an enabled "Add a surface scan" and no Link', async () => {
		const { inbox } = page(fx('link_surface_scan_ok'));
		await inbox.load();
		const file = scanRow(inbox);
		expect(file.kind).toBe('surface_scan');
		expect(primaryAction(file)).toEqual({ kind: 'scan', label: 'Add a surface scan' });
		expect(canChange(file)).toBe(false);
	});

	it.each([
		['link_surface_scan_ok', worn(), 'Added as a surface scan of H13A-#2. It is now visible to every lab member.'],
		[
			'link_surface_scan_ok_edge',
			{ item: edge, condition: 'cleaned', operationId: OP, date: '2026-10-14', conditionNote: 'ultrasonic bath', notes: 'after pass 3' } as ScanAddForm,
			'Added as a surface scan of H13A-#2-fC. It is now visible to every lab member.',
		],
	])('%s: the client sends the fixture\'s request, key for key, and the answer is read as sent', async (name, form, said) => {
		const f = fx(name);
		const { inbox, calls } = page(f);
		await inbox.load();
		expect(await inbox.addScan(scanRow(inbox), form)).toEqual({ ok: true });
		expect(sent(calls)[0].body).toEqual(f.request.body);
		// the linkFiles call alone reads the same answer
		const r = await linkFiles(only(f).api, f.request.body.items);
		expect(r.link_batch_id).toBe(f.body.data.link_batch_id);
		expect(r.linked).toBe(f.body.data.linked);
		expect(r.items).toEqual(f.body.data.items);
		expect(r.items[0]).toMatchObject({ collection: 'surface_scans', record_id: SCAN_ID, junction_id: SCAN_ID, adopted: false });
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: said, undo: { kind: 'batch', id: f.body.data.link_batch_id } });
	});

	it('an edge item names edge_id and an insert item insert_id, never both', async () => {
		expect(fx('link_surface_scan_ok').body.data.items[0]).toMatchObject({ insert_id: INSERT, edge_id: null });
		expect(fx('link_surface_scan_ok_edge').body.data.items[0]).toMatchObject({ insert_id: null, edge_id: EDGE });
		const f = fx('link_surface_scan_ok_edge');
		const item = f.request.body.items[0];
		expect(item).not.toHaveProperty('insert_id');
		expect(item).not.toHaveProperty('record_id');
	});

	it('link_surface_scan_ok_mixed: a sample link and a scan in one batch, each item as the fixture sends it', async () => {
		const f = fx('link_surface_scan_ok_mixed');
		const rows = (await loadFiles(only(fx('files_new')).api, {})).rows;
		const item = scanLinkItem(rows.find((r) => r.candidate_id === SCAN)!, worn());
		const { api, calls } = only(f);
		const r = await linkFiles(api, [{ candidate_id: ID(1001), collection: 'physical_samples', record_id: ID(101) }, item!]);
		expect(calls[0].body).toEqual(f.request.body);
		expect(r.linked).toBe(2);
		expect(r.items.map((i) => i.collection)).toEqual(['physical_samples', 'surface_scans']);
		expect(r.items[1]).toMatchObject({ record_id: SCAN_ID, insert_id: INSERT, edge_id: null, adopted: false });
	});

	it('link_surface_scan_already_linked: the same add again is "That file was already added." with no batch and so no Undo', async () => {
		const f = fx('link_surface_scan_already_linked');
		const { inbox, calls } = page(f);
		await inbox.load();
		expect(await inbox.addScan(scanRow(inbox), worn())).toEqual({ ok: true });
		expect(sent(calls)[0].body).toEqual(f.request.body);
		expect(inbox.notice.value).toMatchObject({ tone: 'ok', text: 'That file was already added.' });
		expect(inbox.notice.value?.undo).toBeUndefined();
		const r = await linkFiles(only(f).api, []);
		expect(r).toMatchObject({ link_batch_id: '', linked: 0 });
		expect(r.items[0]).toMatchObject({ already_linked: true, record_id: SCAN_ID, insert_id: INSERT, edge_id: null });
	});

	it('undo of a batch that added a scan: the request is the fixture\'s and the answer says one file is back in the Inbox', async () => {
		const f = fx('undo_ok_surface_scan');
		const { api, calls } = only(f);
		expect(await undoBatch(api, ID(903))).toBe(1);
		expect(calls[0].body).toEqual(f.request.body);
		const { inbox, calls: pageCalls } = page(fx('link_surface_scan_ok'));
		await inbox.load();
		await inbox.addScan(scanRow(inbox), worn());
		await inbox.undo({ kind: 'batch', id: ID(903) });
		expect(pageCalls.find((c) => c.path === '/d1-inbox/undo')!.body).toEqual(f.request.body);
		expect(inbox.notice.value?.text).toBe('Undone: 1 found file back in your Inbox.');
	});

	it('undo_403_surface_scan: the endpoint\'s words are shown verbatim, with the file in extensions', async () => {
		const f = fx('undo_403_surface_scan');
		const e: any = await undoBatch(only(f).api, ID(903)).catch((x) => x);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'You can no longer delete that surface scan, so adding it cannot be undone.' });
		expect(e.extensions).toMatchObject({ source: 'd1-inbox', candidate_id: SCAN });
		const { inbox } = page(fx('link_surface_scan_ok'), { 'POST /d1-inbox/undo': f });
		await inbox.load();
		await inbox.addScan(scanRow(inbox), worn());
		expect(await inbox.undo({ kind: 'batch', id: ID(903) })).toEqual({ ok: false, message: f.body.errors[0].message });
		expect(inbox.notice.value).toMatchObject({ tone: 'bad', text: f.body.errors[0].message });
	});

	it.each([
		['link_surface_scan_400_condition', 400, 'INVALID_PAYLOAD', 'condition', 'Choose the condition: new, worn, cleaned or other.'],
		['link_surface_scan_400_date', 400, 'INVALID_PAYLOAD', 'scanned_on', 'The scan date is not a valid day. Use the date box, or leave it empty.'],
		['link_surface_scan_400_item', 400, 'INVALID_PAYLOAD', 'edge_id', 'Choose one insert or one edge for the surface scan, not both and not neither.'],
		['link_surface_scan_403_not_allowed', 403, 'FORBIDDEN', null, 'You are not allowed to add surface scans.'],
		['link_surface_scan_404_not_found', 404, 'NOT_FOUND', null, 'That insert, edge or operation does not exist, or you cannot see it. Choose another.'],
		['link_surface_scan_409_already_added', 409, 'ALREADY_ADDED', null, 'That file is already added as a surface scan of this insert or edge.'],
		['link_surface_scan_409_unavailable', 409, 'SURFACE_SCANS_UNAVAILABLE', null, 'Surface scans are not available yet.'],
		['link_409_not_a_surface_scan', 409, 'NOT_A_SURFACE_SCAN', null, 'Only a surface scan file can be added to an insert or an edge.'],
		['link_409_surface_scan', 409, 'SURFACE_SCAN', null, 'A surface scan is added to an insert or an edge.'],
	])('%s: an InboxApiError with status, code and extensions, said in the page\'s own words', async (name, status, code, field, said) => {
		const f = fx(name);
		const { api, calls } = only(f);
		const e: any = await linkFiles(api, f.request.body.items).catch((x) => x);
		expect(calls[0].body).toEqual(f.request.body);
		expect(e).toBeInstanceOf(InboxApiError);
		expect(e).toMatchObject({ status, code, message: f.body.errors[0].message });
		expect(e.extensions).toMatchObject({ source: 'd1-inbox', code });
		if (field) expect(e.extensions.field).toBe(field);
		expect(scanErrorText(e)).toEqual({ message: said, field });
		expect(said).not.toMatch(/\blink|attach/i);
	});

	it('a refusal of the page\'s own add shows the mapped words, names the control, and leaves the row', async () => {
		for (const name of ['link_surface_scan_403_not_allowed', 'link_surface_scan_409_already_added', 'link_surface_scan_409_unavailable', 'link_surface_scan_404_not_found']) {
			const f = fx(name);
			const { inbox, calls } = page(f);
			await inbox.load();
			const out = await inbox.addScan(scanRow(inbox), worn());
			expect(out).toEqual({ ok: false, message: scanErrorText(new InboxApiError(f.body.errors[0].message, { status: f.status, code: f.body.errors[0].extensions.code, extensions: f.body.errors[0].extensions })).message });
			expect(out).not.toHaveProperty('field');
			expect(sent(calls)[0].body).toEqual(f.request.body);
			expect(scanRow(inbox)).toBeDefined();
		}
		// a 400 the endpoint raises names its field (the date a form let through)
		const { inbox } = page(fx('link_surface_scan_400_date'));
		await inbox.load();
		expect(await inbox.addScan(scanRow(inbox), { ...worn(), date: '2026-02-31' })).toMatchObject({ ok: false, field: 'scanned_on' });
	});

	it('the 400s of the fixtures are things the form never sends: no condition, a bad date, both an insert and an edge', () => {
		const file = { candidate_id: SCAN, directus_files_id: ID(3003), rel_path: 'Users/ali1/alicona/H13A-2.al3d' };
		// no condition: the form is not complete, so there is no item to send
		expect(scanAddProblems(emptyScanAdd(insert), file)).toEqual(['Choose the condition.']);
		expect(scanLinkItem(file, emptyScanAdd(insert))).toBeNull();
		// a date that is not a day: refused by the form first
		expect(scanAddProblems({ ...worn(), date: fx('link_surface_scan_400_date').request.body.items[0].scanned_on }, file)).toEqual(['The date is not a date.']);
		// the form holds one item: an insert or an edge, so its item never carries both
		for (const item of [insert, edge]) {
			const body = scanLinkItem(file, { ...emptyScanAdd(item), condition: 'worn' })!;
			expect(['insert_id', 'edge_id'].filter((k) => k in body)).toHaveLength(1);
		}
	});

	it('a file that is not a surface scan is never added as one (link_409_not_a_surface_scan is the endpoint\'s backstop)', async () => {
		const f = fx('link_409_not_a_surface_scan');
		const { inbox, calls } = page(f);
		await inbox.load();
		const image = inbox.main.value.rows.find((r) => r.candidate_id === ID(1001))!;
		expect(await inbox.addScan(image, worn())).toEqual({ ok: false, message: 'Only a surface scan file can be added to an insert or an edge.' });
		expect(sent(calls)).toHaveLength(0);
	});

	it('a surface scan is never sent to /link with a sample, operation or test (link_409_surface_scan is the endpoint\'s backstop)', async () => {
		const f = fx('link_409_surface_scan');
		const { inbox, calls } = page(f);
		await inbox.load();
		expect(await inbox.link(scanRow(inbox), 'physical_samples', ID(101))).toEqual({ ok: false, message: 'A surface scan is added to an insert or an edge.' });
		expect(sent(calls)).toHaveLength(0);
	});

	it('files_linked_surface_scan: the row is read key for key, says what it was added to, and routes to the edge', async () => {
		const f = fx('files_linked_surface_scan');
		const raw: any[] = f.body.data;
		const { api, calls } = only(f);
		const page1 = await loadFiles(api, f.request.query as FilesQuery);
		expect(stringified(calls[0].params)).toEqual(f.request.query);
		expect(ids(page1.rows)).toEqual(raw.map((r) => r.candidate_id));
		raw.forEach((r, i) => {
			const parsed: any = page1.rows[i];
			expect(Object.keys(parsed).sort(), r.candidate_id).toEqual(expectedKeys(r, parsed));
			for (const k of Object.keys(r)) expect(parsed[k], `${r.candidate_id}.${k}`).toEqual(r[k]);
		});
		const [row] = page1.rows;
		expect(isAddedScan(row)).toBe(true);
		expect(row).toMatchObject({ linked_collection: 'surface_scans', linked_record_id: SCAN_ID, linked_label: 'H13A-#2-fC (worn)', linked_insert_id: null, linked_edge_id: EDGE });
		expect(scanTarget(row)).toEqual({ collection: 'insert_edges', id: EDGE });
		expect(recordRoute(scanTarget(row)!.collection, scanTarget(row)!.id)).toBe(`/home/edges/${EDGE}`);
		const [batch] = batchesOf(page1.rows);
		expect(batch).toMatchObject({ id: ID(903), count: 1, kind: 'manual', scans: 1 });
		expect(batchTitle(batch)).toBe('Added as a surface scan, 1 file');
		expect(groupLinked(page1.rows).every((g) => g.batch !== null)).toBe(true);
	});
});

// ---- every fixture was used ---------------------------------------------------------------------------------------------------------------

describe('coverage', () => {
	it('every fixture was fed through the client (add a test for a new one)', () => {
		const unused = FIXTURE_NAMES.filter((n) => !used.has(n));
		expect(unused).toEqual([]);
		expect(acceptPairs([], [], () => null)).toEqual({ pairs: [], all: true });
		expect(linkTarget('physical_samples')).not.toBeNull();
		expect(parseFile(null)).toBeNull();
	});
});
