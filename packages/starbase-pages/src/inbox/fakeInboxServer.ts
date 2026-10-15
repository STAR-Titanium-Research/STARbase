// A fake d1-inbox for tests: the routes of spec section 9 over an in-memory list of found files, behind the HostApi shape the pages use.
// It is what the model, API and page tests (and the Playwright spec's stand-in server) run against, so the payload shapes of inboxApi.ts
// are exercised end to end without a backend. Not a copy of the endpoint's rules beyond what the tests need: a link needs a record id, a
// second link of a linked file is a 409, and the rescan refuses a second request inside 10 minutes.
import type { HostApi } from '@d1/ui';
import type { FoundFile } from './inboxApi';

let counter = 0;

/** One found file with sensible defaults; override what the test is about. */
export function foundFile(over: Partial<FoundFile> = {}): FoundFile {
	counter += 1;
	const n = counter;
	return {
		candidate_id: `c${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
		directus_files_id: `f${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
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
		rel_path: `Users/ab1cd/images/file${n}.tif`,
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
		...over,
	});
}

export interface FakeInboxOptions {
	files?: FoundFile[];
	autoLink?: boolean;
	summary?: Record<string, unknown>;
	admin?: Record<string, unknown>;
	/** Clock for the rescan limit, in ms. */
	now?: () => number;
}

export interface Call {
	method: 'get' | 'post' | 'patch' | 'put' | 'delete';
	path: string;
	body?: unknown;
	params?: Record<string, unknown>;
}

const err = (status: number, message: string, extensions: Record<string, unknown> = {}) =>
	Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { errors: [{ message, extensions: { source: 'd1-inbox', ...extensions } }] } } });

export function createFakeInbox(opts: FakeInboxOptions = {}) {
	const files = [...(opts.files ?? [])];
	const calls: Call[] = [];
	const records: Array<Record<string, unknown>> = [];
	let autoLink = opts.autoLink ?? false;
	let lastRescan: number | null = null;
	const now = opts.now ?? (() => Date.now());
	let batch = 0;

	const tabOf = (f: FoundFile): string => (f.state === 'linked' ? 'linked' : f.state === 'dismissed' ? 'dismissed' : f.state === 'new' && f.origin === 'backlog' ? 'older' : f.state === 'new' ? 'new' : 'gone');

	function list(params: Record<string, any>) {
		const tab = params.tab ?? 'new';
		const kinds = typeof params.kind === 'string' ? params.kind.split(',') : null;
		const strengths = typeof params.strength === 'string' ? params.strength.split(',') : null;
		let rows = files.filter((f) => tabOf(f) === tab);
		if (kinds) rows = rows.filter((f) => kinds.includes(f.kind));
		if (strengths) rows = rows.filter((f) => strengths.includes(f.match_strength));
		if (params.link_kind) rows = rows.filter((f) => f.link_kind === params.link_kind);
		if (params.folder) rows = rows.filter((f) => f.rel_path.slice(0, f.rel_path.lastIndexOf('/')).toLowerCase().includes(String(params.folder).toLowerCase()));
		if (params.owner === 'me') rows = rows.filter((f) => f.owner.kind === 'person');
		else if (typeof params.owner === 'string' && params.owner.startsWith('team:')) rows = rows.filter((f) => f.owner.kind === 'team' && f.owner.id === params.owner.slice(5));
		const day = (f: FoundFile) => (f.source_mtime ?? f.first_seen_at ?? '').slice(0, 10);
		if (params.from) rows = rows.filter((f) => day(f) >= params.from);
		if (params.to) rows = rows.filter((f) => day(f) <= params.to);
		const acceptable = rows.filter((f) => f.match_strength === 'short_id' && f.suggested_record_id && f.kind !== 'surface_scan' && f.state === 'new').length;
		const offset = Number(params.offset ?? 0);
		const limit = Number(params.limit ?? 50);
		return { data: rows.slice(offset, offset + limit), meta: { total: rows.length, acceptable } };
	}

	function summary() {
		const mine = files.filter((f) => f.owner.kind === 'person');
		const n = mine.filter((f) => f.state === 'new' && f.origin === 'new').length;
		const o = mine.filter((f) => f.state === 'new' && f.origin === 'backlog' && f.match_strength === 'short_id').length;
		return { person: { has_alias: true, new: n, older_matches: o }, teams: [], new: n, older_matches: o, ...(opts.summary ?? {}) };
	}

	function link(items: Array<{ candidate_id: string; collection: string; record_id: string }>, kind: 'manual' | 'bulk') {
		const picked = items.map((it) => {
			const f = files.find((x) => x.candidate_id === it.candidate_id);
			if (!f) throw err(404, 'That found file does not exist.');
			if (f.state === 'linked') throw err(409, 'Someone already linked this file.');
			return { f, it };
		});
		batch += 1;
		const id = `b${String(batch).padStart(7, '0')}-0000-4000-8000-000000000000`;
		for (const { f, it } of picked) {
			f.state = 'linked';
			f.link_kind = kind;
			f.link_batch_id = id;
			f.decided_at = new Date(now()).toISOString();
			f.linked_collection = it.collection;
			f.linked_record_id = it.record_id;
			f.linked_label = f.suggested_label && it.record_id === f.suggested_record_id ? f.suggested_label : 'Chosen record';
		}
		return { link_batch_id: id, linked: picked.length };
	}

	const handlers: Record<string, (c: Call) => unknown> = {
		'get /d1-inbox/summary': () => summary(),
		'get /d1-inbox/files': (c) => list(c.params ?? {}),
		'post /d1-inbox/link': (c) => link((c.body as any).items, 'manual'),
		'post /d1-inbox/accept-all': (c) => {
			const page = list({ ...((c.body as any).filter ?? {}), limit: 1000, offset: 0 }).data.filter((f) => f.match_strength === 'short_id' && f.suggested_record_id && f.kind !== 'surface_scan');
			const items = page.map((f) => ({ candidate_id: f.candidate_id, collection: f.suggested_collection as string, record_id: f.suggested_record_id as string }));
			const result = items.length ? link(items, 'bulk') : { link_batch_id: '', linked: 0 };
			return { ...result, skipped: [] };
		},
		'post /d1-inbox/dismiss': (c) => {
			for (const id of (c.body as any).candidate_ids) {
				const f = files.find((x) => x.candidate_id === id);
				if (f) f.state = 'dismissed';
			}
			return { changed: (c.body as any).candidate_ids.length };
		},
		'post /d1-inbox/restore': (c) => {
			for (const id of (c.body as any).candidate_ids) {
				const f = files.find((x) => x.candidate_id === id);
				if (f) f.state = 'new';
			}
			return { changed: (c.body as any).candidate_ids.length };
		},
		'post /d1-inbox/undo': (c) => {
			const rows = files.filter((f) => f.link_batch_id === (c.body as any).link_batch_id && f.state === 'linked');
			for (const f of rows) Object.assign(f, { state: 'new', link_kind: null, link_batch_id: null, decided_at: null, linked_collection: null, linked_record_id: null, linked_label: null });
			return { undone: rows.length };
		},
		'post /d1-inbox/rescan': () => {
			const t = now();
			if (lastRescan !== null && t - lastRescan < 10 * 60_000) {
				throw err(429, 'You rescanned a moment ago.', { code: 'RATE_LIMITED', retry_after_seconds: Math.ceil((10 * 60_000 - (t - lastRescan)) / 1000) });
			}
			lastRescan = t;
			return { queued: true };
		},
		'get /d1-inbox/prefs': () => ({ auto_link: autoLink }),
		'put /d1-inbox/prefs': (c) => {
			autoLink = (c.body as any).auto_link === true;
			return { auto_link: autoLink };
		},
		'get /d1-inbox/admin': () => ({
			status: { desired_state: 'running', interval_minutes: 30, last_heartbeat_at: new Date(now()).toISOString(), last_scan_finished_at: new Date(now() - 600_000).toISOString(), files_registered: files.length, error_count: 0 },
			errors: [],
			unmatched_folders: ['Users/zz9'],
			people_without_alias: [{ person_id: 'p9', full_name: 'Bo Chan', active: true }],
			queued_requests: 0,
			...(opts.admin ?? {}),
		}),
		'post /d1-inbox/admin/scan-all': () => ({ queued: true }),
	};

	function run(method: Call['method'], path: string, body?: unknown, config?: { params?: Record<string, unknown> }) {
		const call: Call = { method, path, body, params: config?.params };
		calls.push(call);
		const h = handlers[`${method} ${path}`];
		if (!h) return Promise.reject(err(404, `No such route: ${method.toUpperCase()} ${path}`));
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

	return { api, files, calls, records, setAutoLink: (v: boolean) => (autoLink = v) };
}
