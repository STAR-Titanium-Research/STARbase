// The Inbox's calls: the d1-inbox endpoint (core/extensions/d1-inbox, spec 2026-10-15-found-files-inbox-design.md section 9).
// Every call returns plain data or throws an InboxApiError that carries the endpoint's own words (errors[0].message) and its HTTP status,
// code and extensions (the d1-record-access error shape, plan Global Constraints: 401 / 403 / 404 / 409 / 400 / 429), so a page shows the
// text it is given.
//
// THE PAYLOAD CONTRACT. The spec fixes the routes and the d1_private.file_candidates columns (migration 193) but leaves the JSON shapes
// open. These interfaces are what this page expects; the endpoint worker (stream B) should match them, and every field marked "optional"
// may be left out. Answers may be the bare JSON or wrapped as `{ data: ... }` (both are read), and a list may carry `meta`.
//
//   GET  /d1-inbox/summary              -> InboxSummary (see @d1/ui inboxSummary.ts; the badge and Home panel read it too)
//   GET  /d1-inbox/files?<FilesQuery>   -> { data: FoundFile[], meta: { total, acceptable? } }
//   POST /d1-inbox/link                 { items: [{ candidate_id, collection, record_id }] } -> LinkResult
//   POST /d1-inbox/accept-all           { filter: FilesQuery } -> AcceptAllResult
//   POST /d1-inbox/dismiss | /restore   { candidate_ids: string[] } -> { changed: number }
//   POST /d1-inbox/undo                 { link_batch_id } -> { undone: number }
//   POST /d1-inbox/rescan               {} -> { queued: true }   (429 when asked again within 10 minutes; extensions.retry_after_seconds optional)
//   GET  /d1-inbox/prefs, PUT /d1-inbox/prefs { auto_link } -> InboxPrefs
//   GET  /d1-inbox/admin                -> InboxAdmin (administrators only)
//   POST /d1-inbox/admin/scan-all       {} -> { queued: true }
import { errorText, parseSummary, type HostApi, type InboxSummary } from '@d1/ui';

const BASE = '/d1-inbox';

/** What kind of thing the crawler thinks a found file is (file_candidates.kind). */
export type FileKind = 'sem_image' | 'surface_scan' | 'image' | 'document' | 'other';
export type MatchStrength = 'short_id' | 'code' | 'edge_code' | 'none';
/** The tabs. `older` is the backlog (origin = 'backlog', state = 'new'); `linked` and `dismissed` are the states of those names. */
export type InboxTab = 'new' | 'older' | 'linked' | 'dismissed';
export type LinkKind = 'manual' | 'bulk' | 'auto';

/** One record a file's path names (file_candidates.matches). `via` is how it was named: 'short_id', 'code' or 'edge_code'. */
export interface FileMatch {
	collection: string;
	record_id: string;
	via: string;
	token: string;
}

/** Whose Inbox a file is in: a person (their personal folder) or a team (its team folder). A bare name is read as a person. */
export interface FileOwner {
	kind: 'person' | 'team';
	id: string | null;
	name: string;
}

/**
 * One found file, as GET /d1-inbox/files returns it: the d1_private.file_candidates columns the page uses, plus labels the server resolves
 * (the page never reads another table to name a record). Dates are ISO strings. `extracted` holds only what the crawler actually read:
 * `kv`, `magnification`, `scale_bar`, `instrument` for an SEM image.
 */
export interface FoundFile {
	candidate_id: string;
	/** The directus_files pointer row: the page asks the asset route for a thumbnail of an image kind with it. */
	directus_files_id: string;
	kind: FileKind;
	kind_confidence: number | null;
	extracted: Record<string, unknown>;
	origin: 'new' | 'backlog';
	state: 'new' | 'linked' | 'dismissed' | 'gone';
	match_strength: MatchStrength;
	matches: FileMatch[];
	suggested_collection: string | null;
	suggested_record_id: string | null;
	/** Server-resolved name of the suggested record ("S-0042"), or null when the caller cannot read it. */
	suggested_label: string | null;
	/** Optional: false when the caller may not edit the suggested record (so Link would be refused). */
	suggested_can_edit?: boolean;
	duplicate_of: string | null;
	/** Optional: whose Inbox the original is in, for "copy of a file in ...". */
	duplicate_of_owner?: string | null;
	rel_path: string;
	size_bytes: number | null;
	source_mtime: string | null;
	first_seen_at: string | null;
	decided_at: string | null;
	link_kind: LinkKind | null;
	link_batch_id: string | null;
	/** Linked tab: the record the file was linked to, with a server-resolved label. */
	linked_collection?: string | null;
	linked_record_id?: string | null;
	linked_label?: string | null;
	/** Optional: the person (login name) who decided it. */
	decided_by_name?: string | null;
	owner: FileOwner;
}

/**
 * GET /d1-inbox/files query. Every key is optional and sent only when set.
 *  - tab: new | older | linked | dismissed (default new)
 *  - kind: comma list of kinds
 *  - folder: text the folder part of rel_path contains (case-insensitive)
 *  - from, to: YYYY-MM-DD, on the file's own date (source_mtime, else first_seen_at), both ends included
 *  - owner: 'me' (my personal folder) or 'team:<team_id>'; omitted = everything the caller may see
 *  - strength: comma list of match strengths
 *  - link_kind: manual | bulk | auto (the "Recently auto-linked" list asks tab=linked&link_kind=auto)
 *  - limit, offset: paging
 */
export interface FilesQuery {
	tab?: InboxTab;
	kind?: string;
	folder?: string;
	from?: string;
	to?: string;
	owner?: string;
	strength?: string;
	link_kind?: LinkKind;
	limit?: number;
	offset?: number;
}

export interface FilesPage {
	rows: FoundFile[];
	/** Rows the query matches in all (the page shows one page of them). */
	total: number;
	/** Optional: how many of the matching rows Accept all would link (server-evaluated); the page estimates from the rows when absent. */
	acceptable: number | null;
}

export interface LinkItem {
	candidate_id: string;
	collection: string;
	record_id: string;
}
export interface LinkResult {
	link_batch_id: string;
	linked: number;
}
export interface AcceptAllResult extends LinkResult {
	/** Rows the filter matched that were not linked (not exact, not editable, a document the caller left alone...). */
	skipped: Array<{ candidate_id: string; reason: string }>;
}

export interface InboxPrefs {
	auto_link: boolean;
}

export interface CrawlerStatus {
	desired_state: string | null;
	interval_minutes: number | null;
	last_heartbeat_at: string | null;
	daemon_started_at: string | null;
	current_activity: string | null;
	last_scan_started_at: string | null;
	last_scan_finished_at: string | null;
	files_registered: number;
	error_count: number;
	last_error: string | null;
}
export interface PersonWithoutAlias {
	person_id: string;
	full_name: string;
	/** A Former person (active = false) is not scanned unless scan_while_former is on. */
	active: boolean;
}
export interface ScanError {
	at: string | null;
	message: string;
}
/** GET /d1-inbox/admin: inbox_crawler_state, the folders under Users/ and Shared/ that match no one, and the people with no alias. */
export interface InboxAdmin {
	status: CrawlerStatus;
	/** Recent failures (failed scan requests, scan aborts); status.last_error is the latest. Optional. */
	errors: ScanError[];
	/** Share-relative paths ("Users/zz9", "Shared/Old project") of folders no alias or share folder names. */
	unmatched_folders: string[];
	people_without_alias: PersonWithoutAlias[];
	/** Optional: scan requests waiting for the daemon. */
	queued_requests: number;
}

/**
 * What a failed call throws: the endpoint's message, plus its HTTP status, error code and `extensions`, so a page can act on them (a 429
 * says when to ask again in extensions.retry_after_seconds, a 409 is "someone already linked this"). All unset for a network error.
 */
export class InboxApiError extends Error {
	status?: number;
	code?: string;
	extensions?: Record<string, unknown>;
	constructor(message: string, detail: { status?: number; code?: string; extensions?: Record<string, unknown> } = {}) {
		super(message);
		this.name = 'InboxApiError';
		this.status = detail.status;
		this.code = detail.code;
		this.extensions = detail.extensions;
	}
}

async function call<T>(work: () => Promise<{ data: any }>, shape: (body: any) => T): Promise<T> {
	let body: unknown;
	try {
		body = (await work()).data;
	} catch (e: any) {
		const first = e?.response?.data?.errors?.[0];
		throw new InboxApiError(errorText(e, 'Could not reach the server.'), {
			status: e?.response?.status,
			code: first?.extensions?.code,
			extensions: first?.extensions,
		});
	}
	// d1-record-access answers the bare JSON, /items answers { data }: read both.
	const bare = body && typeof body === 'object' && !Array.isArray(body) && 'data' in (body as object) && !('meta' in (body as object)) ? (body as any).data : body;
	return shape(bare ?? {});
}

// ---- reading what the server sent: a missing or odd field never throws, it gets a harmless value ----

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const KINDS: readonly string[] = ['sem_image', 'surface_scan', 'image', 'document', 'other'];
const STRENGTHS: readonly string[] = ['short_id', 'code', 'edge_code', 'none'];

function parseOwner(v: unknown): FileOwner {
	if (typeof v === 'string') return { kind: 'person', id: null, name: v };
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	return { kind: o.kind === 'team' || o.type === 'team' ? 'team' : 'person', id: str(o.id), name: str(o.name) ?? '' };
}

/** One row of the server's list as a FoundFile, or null for a row with no id (nothing to act on). */
export function parseFile(v: unknown): FoundFile | null {
	if (!v || typeof v !== 'object') return null;
	const r = v as Record<string, any>;
	const id = str(r.candidate_id);
	if (!id) return null;
	const kind = KINDS.includes(r.kind) ? (r.kind as FileKind) : 'other';
	const strength = STRENGTHS.includes(r.match_strength) ? (r.match_strength as MatchStrength) : 'none';
	const matches: FileMatch[] = (Array.isArray(r.matches) ? r.matches : [])
		.filter((m: any) => m && typeof m.record_id === 'string')
		.map((m: any) => ({ collection: String(m.collection ?? ''), record_id: m.record_id, via: String(m.via ?? ''), token: String(m.token ?? '') }));
	const file: FoundFile = {
		candidate_id: id,
		directus_files_id: str(r.directus_files_id) ?? '',
		kind,
		kind_confidence: num(r.kind_confidence),
		extracted: r.extracted && typeof r.extracted === 'object' && !Array.isArray(r.extracted) ? r.extracted : {},
		origin: r.origin === 'backlog' ? 'backlog' : 'new',
		state: r.state === 'linked' || r.state === 'dismissed' || r.state === 'gone' ? r.state : 'new',
		match_strength: strength,
		matches,
		suggested_collection: str(r.suggested_collection),
		suggested_record_id: str(r.suggested_record_id),
		suggested_label: str(r.suggested_label),
		duplicate_of: str(r.duplicate_of),
		rel_path: typeof r.rel_path === 'string' ? r.rel_path : '',
		size_bytes: num(r.size_bytes),
		source_mtime: str(r.source_mtime),
		first_seen_at: str(r.first_seen_at),
		decided_at: str(r.decided_at),
		link_kind: r.link_kind === 'manual' || r.link_kind === 'bulk' || r.link_kind === 'auto' ? r.link_kind : null,
		link_batch_id: str(r.link_batch_id),
		linked_collection: str(r.linked_collection),
		linked_record_id: str(r.linked_record_id),
		linked_label: str(r.linked_label),
		decided_by_name: str(r.decided_by_name),
		duplicate_of_owner: str(r.duplicate_of_owner),
		owner: parseOwner(r.owner),
	};
	if (typeof r.suggested_can_edit === 'boolean') file.suggested_can_edit = r.suggested_can_edit;
	return file;
}

/** The query as the HTTP client sends it: empty values left out. */
export function filesParams(q: FilesQuery): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(q)) {
		if (v === undefined || v === null || v === '') continue;
		out[k] = v as string | number;
	}
	return out;
}

// ---- the calls ----

/** The counts for the badge, the Home panel and the page header. Shared with the sidebar (@d1/ui), which polls it. */
export const loadSummary = (api: HostApi): Promise<InboxSummary> =>
	call(() => api.get(`${BASE}/summary`), (b) => parseSummary(b) ?? parseSummary({}) as InboxSummary);

export const loadFiles = (api: HostApi, q: FilesQuery): Promise<FilesPage> =>
	call(
		() => api.get(`${BASE}/files`, { params: filesParams(q) }),
		(body) => {
			// A bare array is a list with no meta; the usual answer is { data: [...], meta }, which call() leaves whole because of `meta`.
			const rows = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];
			const files = rows.map(parseFile).filter((f: FoundFile | null): f is FoundFile => f !== null);
			const meta = (body && typeof body === 'object' && !Array.isArray(body) ? body.meta : null) ?? {};
			return { rows: files, total: num(meta.total) ?? files.length, acceptable: num(meta.acceptable) };
		},
	);

export const linkFiles = (api: HostApi, items: LinkItem[]): Promise<LinkResult> =>
	call(() => api.post(`${BASE}/link`, { items }), (b) => ({ link_batch_id: String(b.link_batch_id ?? ''), linked: num(b.linked) ?? items.length }));

export const acceptAll = (api: HostApi, filter: FilesQuery): Promise<AcceptAllResult> =>
	call(
		() => api.post(`${BASE}/accept-all`, { filter: filesParams(filter) }),
		(b) => ({
			link_batch_id: String(b.link_batch_id ?? ''),
			linked: num(b.linked) ?? 0,
			skipped: (Array.isArray(b.skipped) ? b.skipped : []).map((s: any) => ({ candidate_id: String(s?.candidate_id ?? ''), reason: String(s?.reason ?? '') })),
		}),
	);

export const dismissFiles = (api: HostApi, candidateIds: string[]): Promise<number> =>
	call(() => api.post(`${BASE}/dismiss`, { candidate_ids: candidateIds }), (b) => num(b.changed) ?? candidateIds.length);

export const restoreFiles = (api: HostApi, candidateIds: string[]): Promise<number> =>
	call(() => api.post(`${BASE}/restore`, { candidate_ids: candidateIds }), (b) => num(b.changed) ?? candidateIds.length);

export const undoBatch = (api: HostApi, linkBatchId: string): Promise<number> =>
	call(() => api.post(`${BASE}/undo`, { link_batch_id: linkBatchId }), (b) => num(b.undone) ?? 0);

/** Queue a scan of the caller's own folder. A 429 throws an InboxApiError whose status is 429. */
export const rescan = (api: HostApi): Promise<void> => call(() => api.post(`${BASE}/rescan`, {}), () => undefined);

export const loadPrefs = (api: HostApi): Promise<InboxPrefs> => call(() => api.get(`${BASE}/prefs`), (b) => ({ auto_link: b.auto_link === true }));

export const savePrefs = (api: HostApi, prefs: InboxPrefs): Promise<InboxPrefs> =>
	call(
		() => {
			// The endpoint's route is PUT (spec section 9). Both hosts' clients are axios and have it; HostApi lists it as optional.
			if (!api.put) return Promise.reject(new Error('This host cannot send a PUT request.'));
			return api.put(`${BASE}/prefs`, prefs);
		},
		(b) => ({ auto_link: b.auto_link === true }),
	);

const adminStatus = (s: Record<string, any> | null | undefined): CrawlerStatus => ({
	desired_state: str(s?.desired_state),
	interval_minutes: num(s?.interval_minutes),
	last_heartbeat_at: str(s?.last_heartbeat_at),
	daemon_started_at: str(s?.daemon_started_at),
	current_activity: str(s?.current_activity),
	last_scan_started_at: str(s?.last_scan_started_at),
	last_scan_finished_at: str(s?.last_scan_finished_at),
	files_registered: num(s?.files_registered) ?? 0,
	error_count: num(s?.error_count) ?? 0,
	last_error: str(s?.last_error),
});

export const loadAdmin = (api: HostApi): Promise<InboxAdmin> =>
	call(
		() => api.get(`${BASE}/admin`),
		(b) => ({
			status: adminStatus(b.status),
			errors: (Array.isArray(b.errors) ? b.errors : []).map((e: any): ScanError => (typeof e === 'string' ? { at: null, message: e } : { at: str(e?.at), message: String(e?.message ?? '') })).filter((e: ScanError) => e.message),
			unmatched_folders: (Array.isArray(b.unmatched_folders) ? b.unmatched_folders : []).filter((f: unknown): f is string => typeof f === 'string'),
			people_without_alias: (Array.isArray(b.people_without_alias) ? b.people_without_alias : [])
				.filter((p: any) => p && typeof p.person_id === 'string')
				.map((p: any): PersonWithoutAlias => ({ person_id: p.person_id, full_name: String(p.full_name ?? ''), active: p.active !== false })),
			queued_requests: num(b.queued_requests) ?? 0,
		}),
	);

export const scanAll = (api: HostApi): Promise<void> => call(() => api.post(`${BASE}/admin/scan-all`, {}), () => undefined);
