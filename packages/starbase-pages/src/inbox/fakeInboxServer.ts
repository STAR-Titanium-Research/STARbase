// A fake d1-inbox for tests: the routes of spec section 9 over an in-memory list of found files, behind the HostApi shape the pages use. It is
// what the model, API and page tests (and the Playwright spec's stand-in server) run against.
//
// The shapes are d1-inbox's own, as built (core/extensions/d1-inbox/index.js, stream B): every answer is `{ data: ... }`; a list also has
// `meta: { total, limit, offset }` (and `acceptable` only when the request asks with acceptable=1, which the page never does); `link` answers `{ link_batch_id, linked: <count>, items }` and refuses a record the caller
// cannot edit (403 FORBIDDEN) and a file someone else linked (409 ALREADY_LINKED); `accept-all` answers `{ link_batch_id, linked, items, skipped,
// has_more }`, its dry run `{ link_batch_id: null, linked: 0, count, acceptable, ids, items: [], skipped, has_more, dry_run: true }`, takes
// `candidate_ids` (links exactly those), and skips surface scans (SURFACE_SCAN), copies (COPY), records the caller cannot edit (NOT_EDITABLE) and
// files already on the record (ALREADY_ON_RECORD) but takes documents; `rescan` answers 202 and then 429 (RATE_LIMITED, retry_after_seconds)
// inside 10 minutes; errors are `{ errors: [{ message, extensions: { code, source: 'd1-inbox' } }] }`.
// Two options simulate an endpoint that does less: `dryRunIds: false` (a dry run that only counts) and `acceptIds: false` (accept-all that ignores
// `candidate_ids`).
import type { HostApi } from '@d1/ui';
import type { FoundFile } from './inboxApi';

let counter = 0;

/** One found file with sensible defaults; override what the test is about. */
export function foundFile(over: Partial<FoundFile> = {}): FoundFile {
	counter += 1;
	const n = counter;
	const rel_path = over.rel_path ?? `Users/ab1cd/images/file${n}.tif`;
	return {
		candidate_id: `c${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
		directus_files_id: `f${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
		name: rel_path.split('/').pop(),
		kind: 'image',
		kind_confidence: 0.9,
		extracted: {},
		origin: 'new',
		state: 'new',
		match_strength: 'none',
		matches: [],
		suggested_collection: null,
		suggested_record_id: null,
		suggested_label: null,
		duplicate_of: null,
		rel_path,
		size_bytes: 2_500_000,
		source_mtime: '2026-10-10T09:00:00.000Z',
		first_seen_at: '2026-10-11T09:00:00.000Z',
		decided_at: null,
		link_kind: null,
		link_batch_id: null,
		owner: { kind: 'person', id: 'p1', name: 'Ann Lee' },
		...over,
	};
}

/** A file whose name carries the short ID of one sample, as the crawler would have tagged it. */
export function exactMatch(over: Partial<FoundFile> = {}, token = '3fa9c1d2', label = 'S-0042'): FoundFile {
	const record = `a${token}-0000-4000-8000-000000000000`.slice(0, 36);
	return foundFile({
		rel_path: `Users/ab1cd/sem/${token}_A1.tif`,
		kind: 'sem_image',
		match_strength: 'short_id',
		matches: [{ collection: 'physical_samples', record_id: record, via: 'short_id', token }],
		suggested_collection: 'physical_samples',
		suggested_record_id: record,
		suggested_label: label,
		suggested_can_edit: true,
		...over,
	});
}

export interface FakeInboxOptions {
	files?: FoundFile[];
	autoLink?: boolean;
	summary?: Record<string, unknown>;
	admin?: Record<string, unknown>;
	/** Clock for the rescan limit and the heartbeat, in ms. */
	now?: () => number;
	/** May the caller edit this record? Default: yes. A link to a record that fails is 403, and accept-all skips it (NOT_EDITABLE). */
	editable?: (collection: string, recordId: string) => boolean;
	/** The person has no folder: rescan answers 409 NO_FOLDER. */
	noFolder?: boolean;
	/** Accept-all takes `candidate_ids` and links exactly those (default true). */
	acceptIds?: boolean;
	/** A dry run lists the files it would link in `ids` (default true). */
	dryRunIds?: boolean;
}

export interface Call {
	method: 'get' | 'post' | 'patch' | 'put' | 'delete';
	path: string;
	body?: unknown;
	params?: Record<string, unknown>;
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: { errors: [{ message, extensions: { ...extra, code, source: 'd1-inbox' } }] } },
	});

const ACCEPT_LIMIT = 500;

export function createFakeInbox(opts: FakeInboxOptions = {}) {
	const files = [...(opts.files ?? [])];
	const calls: Call[] = [];
	/** "collection:record:file" of every junction row a link made. */
	const junctions = new Map<string, string>();
	let autoLink = opts.autoLink ?? false;
	let lastRescan: number | null = null;
	let scanAllWaiting = false;
	const now = opts.now ?? (() => Date.now());
	const editable = opts.editable ?? (() => true);
	let batch = 0;
	let junction = 0;

	const tabOf = (f: FoundFile): string =>
		f.state === 'linked' ? 'linked' : f.state === 'dismissed' ? 'dismissed' : f.state === 'new' && f.origin === 'backlog' ? 'older' : f.state === 'new' ? 'new' : 'gone';
	const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

	function matching(params: Record<string, any>): FoundFile[] {
		const tab = params.tab ?? 'new';
		const kinds = typeof params.kind === 'string' ? params.kind.split(',') : null;
		const strengths = typeof params.strength === 'string' ? params.strength.split(',') : null;
		let rows = files.filter((f) => (tab === 'open' ? f.state === 'new' : tabOf(f) === tab));
		if (kinds) rows = rows.filter((f) => kinds.includes(f.kind));
		if (strengths) rows = rows.filter((f) => strengths.includes(f.match_strength));
		if (params.link_kind) rows = rows.filter((f) => f.link_kind === params.link_kind);
		if (params.folder) rows = rows.filter((f) => folderOf(f.rel_path).toLowerCase().includes(String(params.folder).toLowerCase()));
		if (params.owner === 'me') rows = rows.filter((f) => f.owner.kind === 'person');
		else if (typeof params.owner === 'string' && params.owner.startsWith('team:')) rows = rows.filter((f) => f.owner.kind === 'team' && f.owner.id === params.owner.slice(5));
		const day = (f: FoundFile) => (f.source_mtime ?? f.first_seen_at ?? '').slice(0, 10);
		if (params.from) rows = rows.filter((f) => day(f) >= params.from);
		if (params.to) rows = rows.filter((f) => day(f) <= params.to);
		return rows;
	}

	// What accept-all does for a filter (or for the given ids): the files it would link, and the ones it leaves with a reason.
	function plan(params: Record<string, any>, ids?: string[]) {
		let rows = matching({ ...params, tab: params.tab ?? 'open' }).filter((f) => f.state === 'new' && f.match_strength === 'short_id' && f.suggested_record_id);
		const has_more = rows.length >= ACCEPT_LIMIT;
		rows = rows.slice(0, ACCEPT_LIMIT);
		if (ids) rows = rows.filter((f) => ids.includes(f.candidate_id));
		const entries: FoundFile[] = [];
		const skipped: Array<{ candidate_id: string; reason: string }> = [];
		for (const f of rows) {
			const reason = f.kind === 'surface_scan' ? 'SURFACE_SCAN'
				: f.duplicate_of ? 'COPY'
				: !editable(f.suggested_collection as string, f.suggested_record_id as string) ? 'NOT_EDITABLE'
				: junctions.has(`${f.suggested_collection}:${f.suggested_record_id}:${f.directus_files_id}`) ? 'ALREADY_ON_RECORD'
				: null;
			if (reason) skipped.push({ candidate_id: f.candidate_id, reason });
			else entries.push(f);
		}
		return { entries, skipped, has_more };
	}

	function summary() {
		const mine = files.filter((f) => f.owner.kind === 'person' && f.state === 'new');
		const n = mine.filter((f) => f.origin === 'new').length;
		const o = mine.filter((f) => f.origin === 'backlog' && f.match_strength === 'short_id' && f.suggested_record_id).length;
		return { person: { person_id: 'p1', has_alias: true, new: n, older_matches: o }, teams: [], new: n, older_matches: o, ...(opts.summary ?? {}) };
	}

	function doLink(items: Array<{ candidate_id: string; collection: string; record_id: string }>, kind: 'manual' | 'bulk') {
		const fresh: Array<{ f: FoundFile; it: (typeof items)[number] }> = [];
		const again: Array<Record<string, unknown>> = [];
		for (const it of items) {
			const f = files.find((x) => x.candidate_id === it.candidate_id);
			if (!f) throw err(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: it.candidate_id });
			if (f.state === 'new') fresh.push({ f, it });
			else if (f.state === 'linked') {
				if (f.linked_collection === it.collection && f.linked_record_id === it.record_id && f.link_kind === 'manual') again.push({ candidate_id: f.candidate_id, collection: it.collection, record_id: it.record_id, already_linked: true });
				else throw err(409, 'ALREADY_LINKED', 'That file was already linked.', { candidate_id: f.candidate_id });
			} else if (f.state === 'gone') throw err(409, 'FILE_GONE', 'That file is no longer on the share.', { candidate_id: f.candidate_id });
			else throw err(409, 'NOT_NEW', 'Restore that file before linking it.', { candidate_id: f.candidate_id });
		}
		for (const { f, it } of fresh) {
			if (!editable(it.collection, it.record_id)) throw err(403, 'FORBIDDEN', 'You can only link a file to a record you can edit.', { candidate_id: f.candidate_id, collection: it.collection, record_id: it.record_id });
			if (junctions.has(`${it.collection}:${it.record_id}:${f.directus_files_id}`)) throw err(409, 'ALREADY_ON_RECORD', 'That file is already linked to that record.', { candidate_id: f.candidate_id });
		}
		if (!fresh.length) return { link_batch_id: null, linked: again.length, items: again };
		batch += 1;
		const id = `b${String(batch).padStart(7, '0')}-0000-4000-8000-000000000000`;
		const made = fresh.map(({ f, it }) => {
			junction += 1;
			const junctionId = `j${String(junction).padStart(7, '0')}-0000-4000-8000-000000000000`;
			junctions.set(`${it.collection}:${it.record_id}:${f.directus_files_id}`, junctionId);
			f.state = 'linked';
			f.link_kind = kind;
			f.link_batch_id = id;
			f.decided_at = new Date(now()).toISOString();
			f.linked_collection = it.collection;
			f.linked_record_id = it.record_id;
			f.linked_label = f.suggested_label && it.record_id === f.suggested_record_id ? f.suggested_label : 'Chosen record';
			return { candidate_id: f.candidate_id, collection: it.collection, record_id: it.record_id, junction_id: junctionId, adopted: !['sem_image', 'image', 'surface_scan'].includes(f.kind) };
		});
		return { link_batch_id: id, linked: made.length + again.length, items: [...made, ...again] };
	}

	const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, ...extra });

	const handlers: Record<string, (c: Call) => unknown> = {
		'get /d1-inbox/summary': () => ok(summary()),
		'get /d1-inbox/files': (c) => {
			const p = c.params ?? {};
			const rows = matching(p);
			const offset = Number(p.offset ?? 0);
			const limit = Number(p.limit ?? 50);
			const asked = p.acceptable === '1' || p.acceptable === 1;
			return ok(rows.slice(offset, offset + limit), { meta: { total: rows.length, limit, offset, ...(asked ? { acceptable: plan(p).entries.length } : {}) } });
		},
		'post /d1-inbox/link': (c) => ok(doLink((c.body as any).items, (c.body as any).items.length === 1 ? 'manual' : 'bulk')),
		'post /d1-inbox/accept-all': (c) => {
			const body = c.body as any;
			const p = plan(body.filter ?? {}, opts.acceptIds !== false && Array.isArray(body.candidate_ids) ? body.candidate_ids : undefined);
			if (body.dry_run === true) {
				const ids = opts.dryRunIds === false ? [] : p.entries.map((f) => f.candidate_id);
				return ok({ link_batch_id: null, linked: 0, count: p.entries.length, acceptable: p.entries.length, ids, items: [], skipped: p.skipped, has_more: p.has_more, dry_run: true });
			}
			if (!p.entries.length) return ok({ link_batch_id: null, linked: 0, items: [], skipped: p.skipped, has_more: p.has_more });
			const done = doLink(p.entries.map((f) => ({ candidate_id: f.candidate_id, collection: f.suggested_collection as string, record_id: f.suggested_record_id as string })), 'bulk');
			return ok({ ...done, skipped: p.skipped, has_more: p.has_more });
		},
		'post /d1-inbox/dismiss': (c) => {
			const ids: string[] = (c.body as any).candidate_ids;
			const changed: string[] = [];
			const unchanged: string[] = [];
			for (const id of ids) {
				const f = files.find((x) => x.candidate_id === id);
				if (!f) throw err(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: id });
				if (f.state === 'new') { f.state = 'dismissed'; f.decided_at = new Date(now()).toISOString(); changed.push(id); }
				else if (f.state === 'dismissed') unchanged.push(id);
				else throw err(409, 'NOT_NEW', 'That file was already linked or is gone.', { candidate_id: id });
			}
			return ok({ changed: changed.length, changed_ids: changed, unchanged_ids: unchanged });
		},
		'post /d1-inbox/restore': (c) => {
			const ids: string[] = (c.body as any).candidate_ids;
			const changed: string[] = [];
			const unchanged: string[] = [];
			for (const id of ids) {
				const f = files.find((x) => x.candidate_id === id);
				if (!f) throw err(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: id });
				if (f.state === 'dismissed') { f.state = 'new'; f.decided_at = null; changed.push(id); }
				else if (f.state === 'new') unchanged.push(id);
				else throw err(409, 'NOT_DISMISSED', 'That file was linked or is gone, so it cannot be restored.', { candidate_id: id });
			}
			return ok({ changed: changed.length, changed_ids: changed, unchanged_ids: unchanged });
		},
		'post /d1-inbox/undo': (c) => {
			const id = (c.body as any).link_batch_id;
			const rows = files.filter((f) => f.link_batch_id === id && f.state === 'linked');
			if (!rows.length) throw err(404, 'NOT_FOUND', 'That batch does not exist or was already undone.');
			for (const f of rows) {
				junctions.delete(`${f.linked_collection}:${f.linked_record_id}:${f.directus_files_id}`);
				Object.assign(f, { state: 'new', link_kind: null, link_batch_id: null, decided_at: null, linked_collection: null, linked_record_id: null, linked_label: null });
			}
			return ok({ link_batch_id: id, undone: rows.length });
		},
		'post /d1-inbox/rescan': () => {
			if (opts.noFolder) throw err(409, 'NO_FOLDER', 'There is no folder to scan yet. Ask an administrator to set your uni alias.');
			const t = now();
			if (lastRescan !== null && t - lastRescan < 10 * 60_000) {
				throw err(429, 'RATE_LIMITED', 'Your folder was scanned or queued a moment ago. Try again in a few minutes.', { retry_after_seconds: Math.ceil((10 * 60_000 - (t - lastRescan)) / 1000) });
			}
			lastRescan = t;
			return ok({ queued: true, request_id: 'r1', status: 'queued', requested_at: new Date(t).toISOString() });
		},
		'get /d1-inbox/prefs': () => ok({ auto_link: autoLink }),
		'put /d1-inbox/prefs': (c) => {
			autoLink = (c.body as any).auto_link === true;
			return ok({ auto_link: autoLink });
		},
		'get /d1-inbox/admin': () =>
			ok({
				status: {
					desired_state: 'running', interval_minutes: 30, read_mb_per_s: 60, daemon: 'alive', last_heartbeat_at: new Date(now()).toISOString(), daemon_started_at: null,
					current_activity: null, last_scan_started_at: null, last_scan_finished_at: new Date(now() - 600_000).toISOString(), files_registered: files.length, error_count: 0, last_error: null,
				},
				errors: [],
				unmatched_folders: ['Users/zz9'],
				people_without_alias: [{ person_id: 'p9', full_name: 'Bo Chan', active: true, has_login: true }],
				queued_requests: scanAllWaiting ? 1 : 0,
				queue: { queued: scanAllWaiting ? 1 : 0, running: 0 },
				candidates: { new: files.filter((f) => f.state === 'new').length, linked: files.filter((f) => f.state === 'linked').length },
				...(opts.admin ?? {}),
			}),
		'post /d1-inbox/admin/scan-all': () => {
			if (scanAllWaiting) throw err(409, 'ALREADY_QUEUED', 'A scan of everyone is already waiting or running.');
			scanAllWaiting = true;
			return ok({ queued: true, request_id: 'r2', status: 'queued', requested_at: new Date(now()).toISOString() });
		},
	};

	function run(method: Call['method'], path: string, body?: unknown, config?: { params?: Record<string, unknown> }) {
		const call: Call = { method, path, body, params: config?.params };
		calls.push(call);
		const h = handlers[`${method} ${path}`];
		if (!h) return Promise.reject(err(404, 'ROUTE_NOT_FOUND', `Route ${path} doesn't exist.`));
		try {
			// The answer is cloned, like an HTTP response: a page never holds the server's own rows.
			return Promise.resolve({ data: JSON.parse(JSON.stringify(h(call))) });
		} catch (e) {
			return Promise.reject(e);
		}
	}

	const api: HostApi = {
		get: (path, config) => run('get', path, undefined, config),
		post: (path, body, config) => run('post', path, body, config),
		patch: (path, body, config) => run('patch', path, body, config),
		put: (path, body, config) => run('put', path, body, config),
		delete: (path, config) => run('delete', path, undefined, config),
	};

	return { api, files, calls, junctions, setAutoLink: (v: boolean) => (autoLink = v) };
}
