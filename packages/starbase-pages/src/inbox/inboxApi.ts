// The Inbox's calls: the d1-inbox endpoint (core/extensions/d1-inbox, spec 2026-10-15-found-files-inbox-design.md section 9).
// Every call returns plain data or throws an InboxApiError that carries the endpoint's own words (errors[0].message) and its HTTP status,
// code and extensions (the d1-record-access error shape, plan Global Constraints: 401 / 403 / 404 / 409 / 400 / 429), so a page shows the
// text it is given.
//
// THE PAYLOAD CONTRACT is d1-inbox's own (core/extensions/d1-inbox/index.js, stream B, header comment and fileOut / shapeSummary / the routes):
// the server is the source of truth and these interfaces follow it. Every answer is `{ data: ... }` (a list also carries `meta`); the client also
// reads a bare body. Fields marked "optional" may be left out.
//
//   GET  /d1-inbox/summary              -> { data: InboxSummary } (see @d1/ui inboxSummary.ts; the badge and Home panel read it too)
//   GET  /d1-inbox/files?<FilesQuery>   -> { data: FoundFile[], meta: { total, limit, offset, acceptable | null } }
//   GET  /d1-inbox/files/<id>/thumb | /preview  -> the picture itself (image/jpeg, not { data }), only for a file with has_thumbnail; 404 when the
//                                       caller cannot see the file or it has none. Fetched as a blob with the signed-in session (loadPicture).
//   POST /d1-inbox/link                 { items: [{ candidate_id, collection, record_id } | ScanLinkItem] } -> { data: { link_batch_id, linked: <count>, items } };
//                                       403 when the caller cannot edit the record, 409 when someone else got there first. A surface scan is ADDED, not
//                                       linked: its item is a ScanLinkItem (insert_id | edge_id, condition, ...); a repeat by the same person answers
//                                       link_batch_id null, linked 0 and the item `already_linked: true`. Errors: inboxScan.ts scanErrorText.
//   POST /d1-inbox/accept-all           { filter, dry_run?, candidate_ids? } -> { data: { link_batch_id, linked: <count>, items, skipped: [{ candidate_id,
//                                       reason }], has_more } }; a dry run changes nothing and answers the count it would link (`count`, or
//                                       `acceptable`) and the files it would link (`ids`, or `items`); candidate_ids links exactly those
//   POST /d1-inbox/dismiss | /restore   { candidate_ids } -> { data: { changed, changed_ids, unchanged_ids } }
//   POST /d1-inbox/undo                 { link_batch_id } -> { data: { link_batch_id, undone } }
//   POST /d1-inbox/rescan               202 { data: { queued: true } }; 429 (extensions.retry_after_seconds) within 10 minutes or while a scan is
//                                       queued or running; 409 NO_FOLDER when the person has no folder
//   GET  /d1-inbox/prefs, PUT /d1-inbox/prefs { auto_link } -> { data: { auto_link } }
//   GET  /d1-inbox/ignored-folders      -> { data: [{ ignored_id, folder, owner: { kind: 'person' | 'team', id, name }, created_at, can_remove }] }: the caller's own
//                                       rules and their teams'; can_remove is false for a Lab Viewer. `folder` is relative to the owner's root.
//   POST /d1-inbox/ignored-folders      { folder, team_id? } -> 201 { data: { ignored_id, folder, team_id, dismissed } }: `dismissed` is how many open files below the
//                                       folder moved to Dismissed in the same transaction (restorable). 400 INVALID_PAYLOAD (extensions.field 'folder'), 403 FORBIDDEN
//                                       (a team the caller is not in), 409 NO_FOLDER / ALREADY_IGNORED / TOO_MANY_RULES (200 per owner).
//   DELETE /d1-inbox/ignored-folders/<id> -> { data: { ignored_id, folder, rescan_queued } }: the next scan lists the folder again; the rate limit never fails the
//                                       delete (rescan_queued says whether a rescan was queued). 404 NOT_FOUND for a rule that is not the caller's or their team's.
//   GET  /d1-inbox/admin                -> { data: InboxAdmin } (administrators only)
//   POST /d1-inbox/admin/scan-all       202 { data: { queued: true } }; 409 ALREADY_QUEUED while one waits
//
// The first page of a New or Older list asks for meta.acceptable (acceptable=1: how many files Accept all would link under the whole filter), so the
// button can say so, or say that there is nothing to accept. The dry run, asked when the confirm opens, is still the count the confirm trusts. A dry run
// that lists its files is previewed and confirmed file by file; one that does not is confirmed by the same filter.
import { errorText, parseSummary, type HostApi, type InboxSummary } from '@d1/ui';
import type {
	AcceptAllResult, AcceptOptions, CrawlerStatus, FileKind, FileMatch, FileOwner, FilesPage, FilesQuery, FoundFile, IgnoredAdded, IgnoredRemoved, IgnoredRule, InboxAdmin,
	InboxPrefs, LinkItem, LinkResult, MatchStrength, LinkedItem, PersonWithoutAlias, ScanError, ScanLinkItem, Skipped,
} from './inboxApiTypes';

export type * from './inboxApiTypes';

const BASE = '/d1-inbox';

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

/** A name, `{ kind: 'other' }` (a copy in an Inbox the caller has no part in), or null (not a copy). Anything else is read as "no name". */
function parseDuplicateOwner(v: unknown): string | { kind: 'other' } | null {
	if (v && typeof v === 'object' && !Array.isArray(v)) return { kind: 'other' };
	return str(v);
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
		duplicate_of_owner: parseDuplicateOwner(r.duplicate_of_owner),
		owner: parseOwner(r.owner),
		has_thumbnail: r.has_thumbnail === true,
	};
	if (typeof r.suggested_can_edit === 'boolean') file.suggested_can_edit = r.suggested_can_edit;
	if (str(r.name)) file.name = str(r.name) as string;
	if (typeof r.mime_type === 'string' || r.mime_type === null) file.mime_type = r.mime_type;
	if (typeof r.adopted === 'boolean') file.adopted = r.adopted;
	// only a row added as a surface scan carries these (the server leaves them out of any other row)
	if ('linked_insert_id' in r) file.linked_insert_id = str(r.linked_insert_id);
	if ('linked_edge_id' in r) file.linked_edge_id = str(r.linked_edge_id);
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

export type PictureSize = 'thumb' | 'preview';

/** How long a picture request may take before it fails like any other (a stalled one must not hold one of the store's four slots for the session). */
export const PICTURE_TIMEOUT_MS = 30_000;

/**
 * One picture of a found file as an object URL (the caller revokes it with URL.revokeObjectURL, see inboxPictures.ts). The request carries the
 * signed-in session like every other call, so no unauthenticated URL exists; an <img src> to the endpoint would not work in both hosts. Throws an
 * InboxApiError (status 404 when the caller cannot see the file or it has no picture) or, for a timeout (PICTURE_TIMEOUT_MS) or an answer that is not a
 * picture, one without a status.
 */
export async function loadPicture(api: HostApi, candidateId: string, size: PictureSize): Promise<string> {
	let data: unknown;
	try {
		data = (await api.get(`${BASE}/files/${encodeURIComponent(candidateId)}/${size}`, { responseType: 'blob', timeout: PICTURE_TIMEOUT_MS })).data;
	} catch (e: any) {
		// The error body of a blob request is a blob too, so the endpoint's own words are not read: a picture that fails to load fails quietly.
		throw new InboxApiError('The picture could not be loaded.', { status: e?.response?.status });
	}
	const blob = data instanceof Blob ? data : data instanceof ArrayBuffer ? new Blob([data], { type: 'image/jpeg' }) : null;
	if (!blob || blob.size === 0 || (blob.type && !blob.type.startsWith('image/'))) throw new InboxApiError('The answer was not a picture.');
	if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new InboxApiError('This browser cannot show the picture.');
	return URL.createObjectURL(blob);
}

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

/** The items of a link or accept-all answer: the ones that name a file and a record. */
function linkedItems(v: unknown): LinkedItem[] {
	return (Array.isArray(v) ? v : [])
		.filter((i: any) => i && typeof i.candidate_id === 'string' && typeof i.record_id === 'string')
		.map((i: any): LinkedItem => {
			const item: LinkedItem = { candidate_id: i.candidate_id, collection: String(i.collection ?? ''), record_id: i.record_id };
			if (typeof i.label === 'string') item.label = i.label;
			if (typeof i.junction_id === 'string') item.junction_id = i.junction_id;
			if (typeof i.adopted === 'boolean') item.adopted = i.adopted;
			if (i.already_linked === true) item.already_linked = true;
			if ('insert_id' in i) item.insert_id = str(i.insert_id);
			if ('edge_id' in i) item.edge_id = str(i.edge_id);
			return item;
		});
}

/** How many files an answer says it linked: its `linked` count (a list, as an older draft sent it, counts its length), else its items. */
const linkedCount = (b: any, items: LinkedItem[]): number => (Array.isArray(b.linked) ? b.linked.length : num(b.linked) ?? (b.dry_run === true ? 0 : num(b.count) ?? items.length));

export const linkFiles = (api: HostApi, items: Array<LinkItem | ScanLinkItem>): Promise<LinkResult> =>
	call(
		() => api.post(`${BASE}/link`, { items }),
		(b) => {
			const done = linkedItems(b.items);
			return { link_batch_id: String(b.link_batch_id ?? ''), linked: linkedCount(b, done), items: done };
		},
	);

/**
 * Accept all (decision D9). With `dryRun` nothing is changed: the answer says how many files a real run would link (`acceptable`), which it
 * would leave and why (`skipped`), and whether more matched than one run takes (`has_more`). `candidateIds` asks for exactly those files.
 */
export const acceptAll = (api: HostApi, filter: FilesQuery, opts: AcceptOptions = {}): Promise<AcceptAllResult> =>
	call(
		() => api.post(`${BASE}/accept-all`, { filter: filesParams(filter), ...(opts.dryRun ? { dry_run: true } : {}), ...(opts.candidateIds ? { candidate_ids: opts.candidateIds } : {}) }),
		(b) => {
			const done = linkedItems(b.items);
			const linked = linkedCount(b, done);
			const skipped = (Array.isArray(b.skipped) ? b.skipped : []).map((s: any): Skipped => ({ candidate_id: String(s?.candidate_id ?? ''), reason: String(s?.reason ?? '') }));
			return {
				link_batch_id: typeof b.link_batch_id === 'string' ? b.link_batch_id : '',
				linked,
				items: done,
				skipped,
				skippedTotal: Math.max(num(b.skipped_total) ?? 0, skipped.length),
				has_more: b.has_more === true,
				dry_run: b.dry_run === true,
				acceptable: num(b.acceptable) ?? num(b.count) ?? (Array.isArray(b.ids) ? b.ids.length : linked),
				ids: Array.isArray(b.ids) ? b.ids.filter((i: unknown): i is string => typeof i === 'string') : done.map((i) => i.candidate_id),
			};
		},
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

/** The rules the caller may see: their own folder's and their teams'. A row with no id is left out. */
export const listIgnored = (api: HostApi): Promise<IgnoredRule[]> =>
	call(
		() => api.get(`${BASE}/ignored-folders`),
		(b) =>
			(Array.isArray(b) ? b : Array.isArray(b.data) ? b.data : [])
				.filter((r: any) => r && typeof r.ignored_id === 'string' && typeof r.folder === 'string')
				.map((r: any): IgnoredRule => ({ ignored_id: r.ignored_id, folder: r.folder, owner: parseOwner(r.owner), created_at: str(r.created_at), can_remove: r.can_remove === true })),
	);

/** Ignore a folder (relative to the owner's root; `teamId` for a team folder). The server answers 201 and dismisses the owner's open files below it. */
export const addIgnored = (api: HostApi, folder: string, teamId?: string | null): Promise<IgnoredAdded> =>
	call(
		() => api.post(`${BASE}/ignored-folders`, { folder, ...(teamId ? { team_id: teamId } : {}) }),
		(b) => ({ ignored_id: String(b.ignored_id ?? ''), folder: typeof b.folder === 'string' ? b.folder : folder, team_id: str(b.team_id), dismissed: Math.max(0, num(b.dismissed) ?? 0) }),
	);

export const removeIgnored = (api: HostApi, ignoredId: string): Promise<IgnoredRemoved> =>
	call(
		() => api.delete(`${BASE}/ignored-folders/${encodeURIComponent(ignoredId)}`),
		(b) => ({ ignored_id: String(b.ignored_id ?? ignoredId), folder: typeof b.folder === 'string' ? b.folder : '', rescan_queued: b.rescan_queued === true }),
	);

const adminStatus = (s: Record<string, any> | null | undefined): CrawlerStatus => ({
	desired_state: str(s?.desired_state),
	interval_minutes: num(s?.interval_minutes),
	daemon: s?.daemon === 'alive' || s?.daemon === 'paused' || s?.daemon === 'stale' || s?.daemon === 'never' ? s.daemon : null,
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
				.map((p: any): PersonWithoutAlias => ({ person_id: p.person_id, full_name: String(p.full_name ?? ''), active: p.active !== false, has_login: p.has_login === true })),
			queued_requests: num(b.queued_requests) ?? 0,
			queue: { queued: num(b.queue?.queued) ?? 0, running: num(b.queue?.running) ?? 0 },
			candidates: Object.fromEntries(Object.entries(b.candidates && typeof b.candidates === 'object' ? b.candidates : {}).map(([k, v]) => [k, num(v) ?? 0])),
		}),
	);

export const scanAll = (api: HostApi): Promise<void> => call(() => api.post(`${BASE}/admin/scan-all`, {}), () => undefined);
