// Pure list logic for Settings > Local Captures: what state a row is in, which rows may be
// selected for bulk delete, which are cleanup candidates, and the progress/result bookkeeping for
// bulk delete and upload-all. No fetch, no Vue, so the safety rules are unit-testable. Design:
// docs/superpowers/specs/2026-10-06-captures-list-design.md.
//
// The one rule that matters: "uploaded" must be POSITIVELY known. Unknown (Directus unreachable)
// is not "uploaded", and a capture still queued for upload is not uploaded yet.

export interface ListCapture {
	id: string;
	size_mb: number;
	finalized: boolean;
	sample_name?: string;
	/** Folder mtime, seconds since the epoch (0 when unknown). */
	mtime: number;
	recording?: boolean;
	discarding?: boolean;
	recovering?: boolean;
}

/** What the page knows about each capture beyond what the recorder reports. */
export interface RowFacts {
	/** The Directus lookup succeeded. When false, `uploaded` says nothing. */
	uploadedKnown: boolean;
	/** Fully uploaded: operation row, files and analysis row (captureUploadState.ts). */
	uploaded: Record<string, boolean>;
	/** An operation row exists but the upload never finished. Still the only copy. */
	partial?: Record<string, boolean>;
	/** Captures with an upload, delete or recover in flight from this page. */
	busyIds?: ReadonlySet<string>;
	/** Captures whose database record is still waiting in the offline queue. */
	queuedIds: ReadonlySet<string>;
	/** Ids with a complete copy on the remote backup server; null when that is unknown. */
	remoteComplete: ReadonlySet<string> | null;
}

export type RowState =
	| 'incomplete' // never finalized
	| 'working' // being recorded, deleted or recovered right now
	| 'unknown' // finalized, but the database could not be asked
	| 'queued' // finalized, upload waiting in the offline queue
	| 'partial' // finalized, an upload started (operation row) but never finished
	| 'not_uploaded'
	| 'uploaded';

export function rowState(c: ListCapture, f: RowFacts): RowState {
	if (c.recording || c.discarding || c.recovering) return 'working';
	if (!c.finalized) return 'incomplete';
	if (!f.uploadedKnown) return 'unknown';
	if (f.uploaded[c.id]) return 'uploaded';
	if (f.queuedIds.has(c.id)) return 'queued';
	if (f.partial?.[c.id]) return 'partial';
	return 'not_uploaded';
}

/** Whether a row's Upload action is on offer. Uploading twice creates a second operation row, so
 * it needs a positively known state, no queued copy, and nothing already running for the row. */
export function canUploadCapture(c: ListCapture, f: RowFacts): boolean {
	return c.finalized && f.uploadedKnown && !f.uploaded[c.id] && !f.queuedIds.has(c.id)
		&& !f.busyIds?.has(c.id) && !c.recording && !c.discarding && !c.recovering;
}

// ---- Filter ----

export type StatusFilter = 'all' | 'not_uploaded' | 'uploaded' | 'incomplete';
export type ServerStatus = 'finalized' | 'incomplete';

/** The part of a status chip the recorder can apply. Upload state is Directus's, so the two
 * upload chips only narrow to finalized captures on the server and finish in the browser. */
export function serverStatusFor(filter: StatusFilter): ServerStatus | undefined {
	if (filter === 'incomplete') return 'incomplete';
	if (filter === 'not_uploaded' || filter === 'uploaded') return 'finalized';
	return undefined;
}

/** Whether a status chip is applied in the browser, so that the server's `total` overstates the
 * number of matches and more pages may be needed to fill a view. */
export const isClientFilter = (filter: StatusFilter): boolean =>
	filter === 'not_uploaded' || filter === 'uploaded';

/** Rows per request. A browser-side chip scans pages until a screenful matches, and each page costs
 * the recorder a scan of the whole drive plus a Directus lookup for its ids, so those chips ask for
 * the largest page the recorder allows instead of many small ones. */
export const pageSizeFor = (filter: StatusFilter, normal: number, max: number): number =>
	isClientFilter(filter) ? max : normal;

/** The captures whose upload state has not been looked up yet: only these go to Directus when a
 * page is appended, the rest keep what they were found to be. */
export const idsToLookUp = <T extends { id: string }>(rows: T[], checked: ReadonlySet<string>): T[] =>
	rows.filter((c) => !checked.has(c.id));

/** "Not uploaded" means every finalized capture without a database record, queued ones and ones
 * whose state is unknown included: hiding those would hide the captures most at risk. */
export function matchesFilter(c: ListCapture, filter: StatusFilter, f: RowFacts): boolean {
	const st = rowState(c, f);
	switch (filter) {
		case 'all': return true;
		case 'incomplete': return !c.finalized;
		case 'uploaded': return st === 'uploaded';
		case 'not_uploaded': return c.finalized && st !== 'uploaded' && st !== 'working';
	}
}

/** Keep fetching pages while a browser-side filter has not yet produced a page's worth of rows
 * and the server still has unseen captures. */
export function needsMorePages(o: { loaded: number; total: number; matched: number; wanted: number }): boolean {
	return o.loaded < o.total && o.matched < o.wanted;
}

// ---- Selection and bulk delete ----

/** Incomplete captures are never selectable in bulk (recover them, or delete one at a time where
 * the dialog says what is lost), nor is anything being recorded, deleted or recovered. */
export function isBulkSelectable(c: ListCapture, f?: Pick<RowFacts, 'busyIds'>): boolean {
	return c.finalized && !c.recording && !c.discarding && !c.recovering && !f?.busyIds?.has(c.id);
}

/** Why bulk delete is unavailable, or null. Without a known upload state it cannot tell which
 * selected captures are the only copy, so it does not run. */
export function bulkDeleteBlockReason(f: RowFacts): string | null {
	return f.uploadedKnown
		? null
		: 'Bulk delete needs to know which captures are uploaded, and the database could not be reached.';
}

export function selectableIds(rows: ListCapture[], f?: Pick<RowFacts, 'busyIds'>): string[] {
	return rows.filter((c) => isBulkSelectable(c, f)).map((c) => c.id);
}

export function toggleId(sel: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(sel);
	if (next.has(id)) next.delete(id); else next.add(id);
	return next;
}

/** Select every selectable row in `rows`, or clear them all if they are already all selected. */
export function toggleAll(sel: ReadonlySet<string>, rows: ListCapture[], f?: Pick<RowFacts, 'busyIds'>): Set<string> {
	const ids = selectableIds(rows, f);
	const all = ids.length > 0 && ids.every((id) => sel.has(id));
	const next = new Set(sel);
	for (const id of ids) { if (all) next.delete(id); else next.add(id); }
	return next;
}

/** Drop selected ids that no longer exist or are no longer selectable (rows reloaded, filter changed). */
export function pruneSelection(sel: ReadonlySet<string>, rows: ListCapture[]): Set<string> {
	const ok = new Set(selectableIds(rows));
	return new Set([...sel].filter((id) => ok.has(id)));
}

export interface DeleteItem {
	id: string;
	size_mb: number;
	state: RowState;
	/** Not uploaded and no complete remote copy: deleting it destroys the only copy. */
	onlyCopy: boolean;
}

export interface DeletePlan {
	items: DeleteItem[];
	totalMb: number;
	onlyCopyCount: number;
	/** Selected ids dropped because they are no longer deletable (listed so the user can see it). */
	skipped: string[];
}

/** The bulk-delete confirm, from the selected ids against the current rows and facts. */
export function planBulkDelete(selected: ReadonlySet<string>, rows: ListCapture[], f: RowFacts): DeletePlan {
	const items: DeleteItem[] = [];
	const skipped: string[] = [];
	const byId = new Map(rows.map((c) => [c.id, c]));
	for (const id of selected) {
		const c = byId.get(id);
		if (!c || !isBulkSelectable(c, f)) { skipped.push(id); continue; }
		const state = rowState(c, f);
		items.push({ id, size_mb: c.size_mb, state, onlyCopy: state !== 'uploaded' && !f.remoteComplete?.has(id) });
	}
	items.sort((a, b) => (a.id < b.id ? 1 : -1));
	return {
		items,
		totalMb: sumMb(items),
		onlyCopyCount: items.filter((i) => i.onlyCopy).length,
		skipped,
	};
}

// ---- Free up space ----

/** The cleanup rule, and the only place it lives: finalized, positively uploaded, not queued, not
 * busy, and older than the cutoff by folder mtime. Used for the preview and again at delete time on
 * fresh state. Not uploaded, incomplete and unknown never qualify. */
export function isCleanupCandidate(c: ListCapture, f: RowFacts, cutoffMs: number): boolean {
	if (!f.uploadedKnown || !c.finalized || f.busyIds?.has(c.id)) return false;
	if (rowState(c, f) !== 'uploaded' || f.queuedIds.has(c.id)) return false;
	if (!(c.mtime > 0)) return false;   // unknown age is never "old"
	return c.mtime * 1000 < cutoffMs;
}

export const cleanupCutoff = (olderThanDays: number, nowMs: number): number =>
	nowMs - Math.max(0, olderThanDays) * 24 * 3600 * 1000;

export function cleanupCandidates<T extends ListCapture>(rows: T[], f: RowFacts, olderThanDays: number, nowMs: number): T[] {
	const cutoff = cleanupCutoff(olderThanDays, nowMs);
	return rows.filter((c) => isCleanupCandidate(c, f, cutoff));
}

export interface CleanupPreview {
	count: number;
	totalMb: number;
	oldest: number | null;   // mtime seconds
	newest: number | null;
}

export function summarizeCleanup(cands: ListCapture[]): CleanupPreview {
	const times = cands.map((c) => c.mtime);
	return {
		count: cands.length,
		totalMb: sumMb(cands),
		oldest: times.length ? Math.min(...times) : null,
		newest: times.length ? Math.max(...times) : null,
	};
}

/** Right before one bulk delete: why this capture must be skipped, judged on a freshly fetched row
 * and fresh facts rather than the row the plan was made from, or null when it may go. `fresh` is
 * null when the capture is no longer there. */
export function bulkDeleteSkipReason(fresh: ListCapture | null, f: RowFacts): string | null {
	if (!fresh) return 'no longer on disk';
	if (f.busyIds?.has(fresh.id)) return 'busy (an upload or delete is running for it)';
	if (!isBulkSelectable(fresh, f)) return 'no longer safe to delete';
	return bulkDeleteBlockReason(f);
}

/** A single-row delete, re-checked right after its confirm dialog resolves: the dialog can stay open
 * while Upload all (or a recover) reaches the row, and the answer was given about the state at
 * click time. Null = go ahead. */
export function deleteAfterConfirmBlockReason(fresh: ListCapture | null, f: Pick<RowFacts, 'busyIds'>): string | null {
	if (!fresh) return 'no longer on disk';
	if (f.busyIds?.has(fresh.id)) return 'busy (an upload or another action is running for it), so it was not deleted';
	return null;
}

/** The same for Free up space: the cleanup rule re-applied to fresh state. */
export function cleanupSkipReason(fresh: ListCapture | null, f: RowFacts, cutoffMs: number): string | null {
	if (!fresh) return 'no longer on disk';
	if (f.busyIds?.has(fresh.id)) return 'busy (an upload or delete is running for it)';
	return isCleanupCandidate(fresh, f, cutoffMs) ? null : 'no longer safe to delete';
}

// ---- Results ----

export interface DeleteResult {
	id: string;
	outcome: 'deleted' | 'failed' | 'skipped';
	freed_mb?: number;
	reason?: string;
}

export interface DeleteSummary {
	deleted: number;
	failed: DeleteResult[];
	skipped: DeleteResult[];
	freedMb: number;
}

export function summarizeDeleteResults(results: DeleteResult[]): DeleteSummary {
	return {
		deleted: results.filter((r) => r.outcome === 'deleted').length,
		failed: results.filter((r) => r.outcome === 'failed'),
		skipped: results.filter((r) => r.outcome === 'skipped'),
		freedMb: round2(results.reduce((s, r) => s + (r.outcome === 'deleted' ? (r.freed_mb ?? 0) : 0), 0)),
	};
}

// ---- Upload all: progress and cancel ----

export type UploadOutcome = 'uploaded' | 'skipped' | 'failed';

export interface UploadProgress {
	total: number;
	/** Items finished (any outcome). */
	done: number;
	uploaded: number;
	skipped: number;
	failed: number;
	/** Label of the item in flight, or null between items and when finished. */
	current: string | null;
	cancelRequested: boolean;
	finished: boolean;
}

export const startUploadProgress = (total: number): UploadProgress => ({
	total, done: 0, uploaded: 0, skipped: 0, failed: 0, current: null, cancelRequested: false, finished: total === 0,
});
export const beginUploadItem = (p: UploadProgress, label: string): UploadProgress => ({ ...p, current: label });
export function finishUploadItem(p: UploadProgress, outcome: UploadOutcome): UploadProgress {
	const done = p.done + 1;
	return { ...p, done, [outcome]: p[outcome] + 1, current: null, finished: done >= p.total };
}
export const requestUploadCancel = (p: UploadProgress): UploadProgress => ({ ...p, cancelRequested: true });
/** Checked between items only: an upload in flight is never interrupted half-way. */
export const shouldStopUploads = (p: UploadProgress): boolean => p.cancelRequested;
export const finishUploads = (p: UploadProgress): UploadProgress => ({ ...p, current: null, finished: true });

export function uploadProgressText(p: UploadProgress): string {
	if (p.finished) {
		const parts = [`${p.uploaded} uploaded`];
		if (p.failed) parts.push(`${p.failed} failed`);
		if (p.skipped) parts.push(`${p.skipped} skipped`);
		const left = p.total - p.done;
		if (left > 0) parts.push(`${left} not attempted (cancelled)`);
		return parts.join(', ');
	}
	const n = Math.min(p.done + 1, p.total);
	const head = `Uploading ${n} of ${p.total}`;
	const cur = p.current ? `: ${p.current}` : '';
	return p.cancelRequested ? `${head}${cur}. Cancelling after this one…` : `${head}${cur}`;
}

/** Total size in MB, rounded to 0.01. */
export const sumMb = (rows: { size_mb: number }[]): number => round2(rows.reduce((s, r) => s + r.size_mb, 0));

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
