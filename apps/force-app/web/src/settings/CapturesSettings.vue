<script setup lang="ts">
// Local capture housekeeping. Captures accumulate on the recording drive indefinitely: "Don't
// save" deliberately leaves the raw on disk, and recovery.discard_session refuses to touch
// finalized sessions — so until now nothing in the app could show what was there, let alone
// remove it. This lists everything with sizes and upload state, and can delete or re-upload.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { getConfig } from '../config';
import { describeFetchError } from '../netErrors';
import { api } from '../directusClient';
import { uploadCaptureColdStart } from '../record/uploadCapture';
import { clearUploadProgress } from '../record/uploadResume';
import { discardQueued, listQueue, retryQueued, syncStatus, uploadQueuedAsMe, type QueuedRun } from '../record/directusSync';
import { authStore } from '../authStore';
import { OFFLINE_SESSION_UPLOAD_MESSAGE, hasServerSession, recorderFromExtra } from '../recorder';
import { confirmAction } from '../ui/confirm';
import EditCaptureMetadataDialog from './EditCaptureMetadataDialog.vue';
import { confirmUploadState, lookupUploadState, recheckUploaded, type RowGetter, type UploadStateResult } from './captureUploadState';
import { remoteCopyLabel } from './backupLabels';
import { fetchRemoteBackupStates } from '../recorderHttp';
import { formatMegabytes } from '../format';
import {
	beginUploadItem, bulkDeleteBlockReason, bulkDeleteSkipReason, canUploadCapture, cleanupCandidates, cleanupCutoff,
	cleanupSkipReason, deleteAfterConfirmBlockReason, finishUploadItem, finishUploads, idsToLookUp, isBulkSelectable, isClientFilter, matchesFilter, needsMorePages,
	pageSizeFor, planBulkDelete,
	pruneSelection, requestUploadCancel, rowState, serverStatusFor, shouldStopUploads, startUploadProgress,
	sumMb, summarizeCleanup, summarizeDeleteResults, toggleAll, toggleId, uploadProgressText,
	type DeleteResult, type RowFacts, type StatusFilter, type UploadOutcome, type UploadProgress,
} from './captureList';
import { canRevealPaths, copyText, revealPath } from '../localPaths';
import { focusIdFrom } from '../ui/focusLink';
import { spotlight } from '../ui/spotlight';

interface Capture {
	id: string;
	/** Absolute folder on the recorder's disk (#96). */
	dir?: string;
	size_mb: number;
	finalized: boolean;
	files: Record<string, number>;
	mtime: number;
	sample_name?: string;
	duration_sec?: number;
	n?: number;
	peaks?: { Fx: number; Fy: number; Fz: number };
	source?: string;
	// Only on incomplete rows (#82): can Recover work, is it being recorded right now, is it mid-delete,
	// is a recover or restore already working on it.
	recoverable?: boolean;
	recording?: boolean;
	discarding?: boolean;
	recovering?: boolean;
}

const base = () => getConfig().recorderUrl;

const PAGE = 200;   // rows per request; the recorder caps a page at 500
const MAX_PAGE = 500;
const captures = ref<Capture[]>([]);
const capturesRoot = ref('');
// Server-side counts: `total` matches the current search and server filter, `totalAll` is everything
// on disk. `matchingMb` is null when the recorder answered from one page without reading the rest.
const total = ref(0);
const totalAll = ref(0);
const matchingMb = ref<number | null>(null);
const disk = ref<{ free_gb?: number; total_gb?: number }>({});
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const query = ref('');
const statusFilter = ref<StatusFilter>('all');
const sortKey = ref<'date_desc' | 'date_asc' | 'size_desc' | 'size_asc'>('date_desc');
// Bumped by every fresh load so a slow answer for an older search or sort cannot overwrite a newer one.
let generation = 0;
const busy = ref<Record<string, string>>({});   // id -> 'deleting' | 'uploading' | 'recovering'
const rowMsg = ref<Record<string, string>>({});
// Which captures already exist in Directus. Looked up once per load so the list can distinguish
// "safe to delete, it's in the database" from "this is the only copy".
// "Uploaded" means the operation row, its files and the analysis row all exist. `partial` is a
// capture with an operation row but no finished upload (an orphan from a died upload): it still
// counts as the only copy and stays uploadable.
const uploaded = ref<Record<string, boolean>>({});
const partial = ref<Record<string, boolean>>({});
// capture_id -> operation_id, for the metadata editor: present means "PATCH the Directus row too,
// not just the local summary.json".
const uploadedOpId = ref<Record<string, string>>({});
const uploadedKnown = ref(false);
const editing = ref<Capture | null>(null);
// Ids that also exist on the remote backup server (a deleted-locally tombstone doesn't count: it
// is only kept to undo the delete). null = couldn't tell (no server configured, or unreachable),
// which must not read as "no remote copy" (#31 cross-link).
const remoteIds = ref<Map<string, string> | null>(null);
async function loadRemoteIds() {
	try {
		const r = await fetchRemoteBackupStates(base());
		remoteIds.value = r.configured ? r.states : null;
	} catch { remoteIds.value = null; }
}
const hasRemote = (id: string) => !!remoteIds.value?.has(id);
// 'complete' = the whole recording; anything else (interrupted, unknown) is only a partial copy.
const remoteState = (id: string): string | null => remoteIds.value?.get(id) ?? null;

interface BrowsePage {
	captures: Capture[];
	total: number;
	total_all: number;
	matching_size_mb: number | null;
	captures_root: string;
	disk: { free_gb?: number; total_gb?: number };
}

async function fetchPage(offset: number, over: { status?: string; sort?: string; q?: string; limit?: number } = {}): Promise<BrowsePage> {
	const p = new URLSearchParams({ limit: String(over.limit ?? pageSizeFor(statusFilter.value, PAGE, MAX_PAGE)), offset: String(offset), sort: over.sort ?? sortKey.value });
	const q = (over.q ?? query.value).trim();
	if (q) p.set('q', q);
	const status = over.status ?? serverStatusFor(statusFilter.value);
	if (status) p.set('status', status);
	const res = await fetch(`${base()}/captures/browse?${p}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function load() {
	const mine = ++generation;
	loading.value = true;
	error.value = '';
	try {
		const data = await fetchPage(0);
		if (mine !== generation) return;
		captures.value = data.captures || [];
		capturesRoot.value = data.captures_root || '';
		total.value = data.total ?? captures.value.length;
		totalAll.value = data.total_all ?? total.value;
		matchingMb.value = data.matching_size_mb ?? null;
		disk.value = data.disk || {};
		selected.value = new Set();
		// A fresh list starts from nothing known: entries from before (a capture uploaded or
		// removed elsewhere meanwhile) must not outlive a reload.
		uploaded.value = {}; partial.value = {}; uploadedOpId.value = {}; checkedIds.clear();
		uploadedKnown.value = false;
		void loadRemoteIds();
		await checkUploaded();
		await fillForClientFilter(mine);
	} catch (e: any) {
		if (mine === generation) error.value = describeFetchError(e, 'failed to list captures');
	} finally {
		if (mine === generation) loading.value = false;
	}
}

async function loadMore() {
	if (loadingMore.value || loading.value || captures.value.length >= total.value) return;
	const mine = generation;
	loadingMore.value = true;
	try {
		await appendPage(mine);
		await fillForClientFilter(mine);
	} catch (e: any) {
		if (mine === generation) error.value = describeFetchError(e, 'failed to load more captures');
	} finally {
		loadingMore.value = false;
	}
}

async function appendPage(mine: number) {
	const data = await fetchPage(captures.value.length);
	if (mine !== generation) return;
	const have = new Set(captures.value.map((c) => c.id));
	captures.value = [...captures.value, ...(data.captures || []).filter((c) => !have.has(c.id))];
	total.value = data.total ?? total.value;
	totalAll.value = data.total_all ?? totalAll.value;
	await checkUploaded();
}

// Upload state is Directus's, so the "Uploaded" and "Not uploaded" chips filter here. Keep fetching
// pages until a page's worth matches or the recorder runs out, so a chip never shows an empty list
// while matching captures sit on page 3.
async function fillForClientFilter(mine: number) {
	while (mine === generation && isClientFilter(statusFilter.value) && uploadedKnown.value
		&& needsMorePages({ loaded: captures.value.length, total: total.value, matched: visible.value.length, wanted: PAGE })) {
		const before = captures.value.length;
		await appendPage(mine);
		if (captures.value.length === before) break;   // nothing new: the list moved under us
	}
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onSearchInput() {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => void load(), 300);
}
onBeforeUnmount(() => clearTimeout(searchTimer));
function setFilter(f: StatusFilter) {
	if (statusFilter.value === f) return;
	statusFilter.value = f;
	void load();
}

/** Which of `rows` are fully uploaded (see captureUploadState.ts). Null when Directus can't be asked. */
async function lookupUploaded(rows: Capture[]): Promise<UploadStateResult | null> {
	// recorded_metadata.capture_id is what both upload paths stamp (workspace.ts and
	// uploadCapture.ts), so it is the link back from a local capture to its database row. Directus
	// can't filter on that JSON key, so candidate rows are fetched and matched client-side. An
	// operation row alone is not "uploaded": the analysis row with its files must exist too.
	try {
		return await lookupUploadState(rows.map((c) => ({ id: c.id, hasMat: hasMat(c) })), getRows);
	} catch {
		// Offline or not permitted: leave the state unknown rather than claiming "not uploaded",
		// which would invite deleting the only copy of a capture that is in fact safe.
		return null;
	}
}
const getRows: RowGetter = async (collection, params) => (await api.get(`/items/${collection}`, { params })).data?.data ?? [];
/** A capture wrote a .mat unless it was too big for the format (the recorder lists the files it has). */
const hasMat = (c: Capture) => c.files?.['capture.mat'] !== undefined;

/** Record what a lookup found for exactly the rows it covered (an entry that is no longer true is cleared). */
function mergeUploaded(rows: Capture[], r: UploadStateResult) {
	const up = { ...uploaded.value };
	const part = { ...partial.value };
	const ops = { ...uploadedOpId.value };
	for (const c of rows) {
		if (r.uploaded[c.id]) up[c.id] = true; else delete up[c.id];
		if (r.partial[c.id]) part[c.id] = true; else delete part[c.id];
		if (r.opIds[c.id]) ops[c.id] = r.opIds[c.id]; else delete ops[c.id];
	}
	uploaded.value = up;
	partial.value = part;
	uploadedOpId.value = ops;
}

// Ids whose upload state has been looked up since the last reload. Loading another page only asks
// Directus about the new ids; the rest keep their cached state.
const checkedIds = new Set<string>();
async function checkUploaded() {
	const rows = idsToLookUp(captures.value, checkedIds);
	if (rows.length) {
		const r = await lookupUploaded(rows);
		if (r) {
			mergeUploaded(rows, r);
			for (const c of rows) checkedIds.add(c.id);
		}
	}
	// Known only when every loaded row has been looked up: a page whose lookup failed leaves its rows
	// "unknown" (never "not uploaded"), and the safety rules switch to their unknown-state behaviour.
	uploadedKnown.value = captures.value.every((c) => checkedIds.has(c.id));
}

// ---- What the list shows ----
// Everything the safety rules in captureList.ts need to know about a row besides the row itself.
const facts = computed<RowFacts>(() => ({
	uploadedKnown: uploadedKnown.value,
	uploaded: uploaded.value,
	partial: partial.value,
	busyIds: new Set(Object.keys(busy.value)),
	queuedIds: queuedCaptureIds.value as Set<string>,
	remoteComplete: remoteIds.value
		? new Set([...remoteIds.value].filter(([, st]) => st === 'complete').map(([id]) => id))
		: null,
}));
const visible = computed(() => captures.value.filter((c) => matchesFilter(c, statusFilter.value, facts.value)));
const loadedMb = computed(() => sumMb(captures.value));
const FILTERS: { key: StatusFilter; label: string }[] = [
	{ key: 'all', label: 'All' },
	{ key: 'not_uploaded', label: 'Not uploaded' },
	{ key: 'uploaded', label: 'Uploaded' },
	{ key: 'incomplete', label: 'Incomplete' },
];

/** Take deleted captures out of the list and the totals without re-scanning the drive. */
function dropRows(rows: Capture[]) {
	const gone = new Set(rows.map((c) => c.id));
	const present = captures.value.filter((c) => gone.has(c.id));
	const mb = present.reduce((s, c) => s + c.size_mb, 0);
	captures.value = captures.value.filter((c) => !gone.has(c.id));
	total.value = Math.max(0, total.value - present.length);
	totalAll.value = Math.max(0, totalAll.value - present.length);
	if (matchingMb.value != null) matchingMb.value = Math.max(0, Number((matchingMb.value - mb).toFixed(2)));
	selected.value = pruneSelection(selected.value, captures.value);
}

/** DELETE one capture; resolves to the recorder's answer, throws with its `detail` on failure. */
async function deleteCapture(id: string): Promise<{ freed_mb?: unknown; detail?: string }> {
	const res = await fetch(`${base()}/captures/${id}`, { method: 'DELETE' });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
	return body;
}

async function remove(c: Capture) {
	const known = uploadedKnown.value;
	const isUp = !!uploaded.value[c.id];
	const warning = isUp
		? 'It has been uploaded to the database, so the analysis record will remain.'
		: remoteState(c.id) === 'complete'
			? 'It has NOT been uploaded, but a copy is on the remote backup server — it stays there until the server\'s retention expires, and can be restored from Settings > Live Backup until then.'
		: known
			? 'It has NOT been uploaded — this is the only copy and it cannot be recovered.'
			: "Its upload status is unknown (the database is unreachable), so this may be the only copy.";
	const ok = await confirmAction({
		title: 'Delete this capture?',
		message: warning,
		detail: 'This cannot be undone.',
		stats: [
			{ label: 'Capture', value: c.sample_name || c.id },
			{ label: 'Size', value: formatMegabytes(c.size_mb) },
			{ label: 'Uploaded to database', value: isUp ? 'yes' : known ? 'no' : 'unknown' },
			...(remoteIds.value ? [{ label: 'Remote backup copy', value: remoteState(c.id) === 'complete' ? 'yes' : hasRemote(c.id) ? 'partial only' : 'no' }] : []),
		],
		confirmLabel: 'Delete permanently',
		tone: 'danger',
	});
	if (!ok) return;
	// The dialog may have stayed open while Upload all (or a recover) reached this row: never delete
	// a capture that is being read or uploaded, and say why nothing happened.
	const blocked = deleteAfterConfirmBlockReason(captures.value.find((x) => x.id === c.id) ?? null, facts.value);
	if (blocked) { rowMsg.value[c.id] = blocked; return; }
	busy.value[c.id] = 'deleting';
	rowMsg.value[c.id] = '';
	try {
		await deleteCapture(c.id);
		dropRows([c]);
	} catch (e: any) {
		rowMsg.value[c.id] = `delete failed: ${e?.message || e}`;
	} finally {
		delete busy.value[c.id];
	}
}

// ---- Bulk delete and "Free up space" ----
// The rules (what may be selected, what cleanup may pick) live in captureList.ts. Every delete
// still goes through DELETE /captures/{id}, whose own checks (recording in progress, recover or
// restore running) are the last gate.
const selected = ref<Set<string>>(new Set());
const selectedRows = computed(() => captures.value.filter((c) => selected.value.has(c.id)));
const selectedMb = computed(() => sumMb(selectedRows.value));
const bulkBlock = computed(() => bulkDeleteBlockReason(facts.value));
const shownSelectable = computed(() => visible.value.filter((c) => isBulkSelectable(c, facts.value)));
const selectableCount = computed(() => shownSelectable.value.length);
const allShownSelected = computed(() => selectableCount.value > 0 && shownSelectable.value.every((c) => selected.value.has(c.id)));
const bulk = ref<{ done: number; total: number; current: string; cancel: boolean } | null>(null);
const bulkReport = ref<{ title: string; text: string; problems: string[] } | null>(null);
const STAT_ROWS = 12;   // items listed in a confirm dialog before "and N more"

function toggleRow(id: string) { selected.value = toggleId(selected.value, id); }
function toggleAllShown() { selected.value = toggleAll(selected.value, visible.value, facts.value); }

const stateText: Record<string, string> = {
	uploaded: 'uploaded', queued: 'NOT uploaded (queued)', partial: 'NOT uploaded (partial)', not_uploaded: 'NOT uploaded', unknown: 'upload state unknown',
};
function listStats(items: { id: string; size_mb: number; state: string }[], nameOf: (id: string) => string) {
	const rows = items.slice(0, STAT_ROWS).map((i) => ({
		label: nameOf(i.id),
		value: `${formatMegabytes(i.size_mb)}, ${stateText[i.state] ?? i.state}`,
	}));
	if (items.length > STAT_ROWS) rows.push({ label: `…and ${items.length - STAT_ROWS} more`, value: '' });
	return rows;
}

/** What one capture looks like right now, read just before it is deleted rather than taken from the
 * row the plan was made from. The recorder's summary says whether it is still there and finalized
 * (and whether it wrote a .mat); the recorder's DELETE then refuses a recording or a recover in
 * flight as the last gate. Null when the capture has gone. Throws when the recorder can't answer. */
async function freshRow(c: Capture): Promise<{ row: Capture; hasMat: boolean } | null> {
	const res = await fetch(`${base()}/captures/${c.id}/summary`);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`summary: HTTP ${res.status}`);
	const sum = await res.json().catch(() => ({}));
	return { row: { ...c, finalized: true }, hasMat: sum?.mat_written !== false };
}

/** Delete one capture at a time. Before each one `skipReason` re-checks it against fresh state (and
 * says why to skip it, or null). Carries on past a failure, stops between items when cancelled, and
 * reports every item. */
async function deleteMany(items: Capture[], skipReason: (c: Capture) => Promise<string | null>): Promise<DeleteResult[]> {
	const results: DeleteResult[] = [];
	bulk.value = { done: 0, total: items.length, current: '', cancel: false };
	for (const c of items) {
		if (bulk.value.cancel) { results.push({ id: c.id, outcome: 'skipped', reason: 'cancelled' }); continue; }
		bulk.value.current = c.sample_name || c.id;
		let reason: string | null;
		try { reason = await skipReason(c); } catch (e: any) { reason = `could not re-check it (${e?.message || e})`; }
		if (reason) {
			results.push({ id: c.id, outcome: 'skipped', reason });
		} else {
			busy.value[c.id] = 'deleting';
			try {
				const body = await deleteCapture(c.id);
				results.push({ id: c.id, outcome: 'deleted', freed_mb: typeof body.freed_mb === 'number' ? body.freed_mb : c.size_mb });
				dropRows([c]);
			} catch (e: any) {
				results.push({ id: c.id, outcome: 'failed', reason: String(e?.message || e) });
			} finally {
				delete busy.value[c.id];
			}
		}
		bulk.value.done++;
	}
	bulk.value = null;
	return results;
}
function cancelBulk() { if (bulk.value) bulk.value.cancel = true; }

function reportDeletes(title: string, results: DeleteResult[]) {
	const sum = summarizeDeleteResults(results);
	const parts = [`Deleted ${sum.deleted}, freed ${formatMegabytes(sum.freedMb)}`];
	if (sum.failed.length) parts.push(`${sum.failed.length} failed`);
	if (sum.skipped.length) parts.push(`${sum.skipped.length} skipped`);
	bulkReport.value = {
		title,
		text: parts.join(', '),
		problems: [
			...sum.failed.map((r) => `${nameOf(r.id)}: failed, ${r.reason}`),
			...sum.skipped.map((r) => `${nameOf(r.id)}: skipped, ${r.reason}`),
		],
	};
}
function nameOf(id: string): string {
	const c = captures.value.find((x) => x.id === id) ?? cleanupPool.value?.find((x) => x.id === id);
	return c?.sample_name || id;
}

async function deleteSelected() {
	if (bulkBlock.value || bulk.value || uploadingAll.value) return;
	const plan = planBulkDelete(selected.value, captures.value, facts.value);
	if (!plan.items.length) return;
	const n = plan.items.length;
	const ok = await confirmAction({
		title: `Delete ${n} capture${n === 1 ? '' : 's'}?`,
		message: plan.onlyCopyCount
			? `${plan.onlyCopyCount} of these ${plan.onlyCopyCount === 1 ? 'has' : 'have'} NOT been uploaded and ${plan.onlyCopyCount === 1 ? 'has' : 'have'} no complete remote backup: for ${plan.onlyCopyCount === 1 ? 'it' : 'them'} this is the only copy and it cannot be recovered.`
			: 'All of these have been uploaded to the database, or have a complete copy on the remote backup server.',
		detail: `Frees about ${formatMegabytes(plan.totalMb)}. This cannot be undone.`,
		stats: listStats(plan.items, nameOf),
		confirmLabel: `Delete ${n} permanently`,
		tone: 'danger',
	});
	if (!ok) return;
	const byId = new Map(captures.value.map((c) => [c.id, c]));
	const rows = plan.items.map((i) => byId.get(i.id)).filter((c): c is Capture => !!c);
	// Re-evaluated per item at delete time on freshly read state: a capture that began uploading or
	// recovering meanwhile, or has gone, is skipped, and so is everything if the database stops answering.
	const results = await deleteMany(rows, async (c) => {
		const fresh = await freshRow(c);
		return bulkDeleteSkipReason(fresh?.row ?? null, facts.value);
	});
	reportDeletes('Bulk delete finished', results);
}

// "Free up space": uploaded captures older than N days. The pool is every finalized capture on
// disk (independent of the list's search and filters), fetched oldest first, so the preview counts
// them all and not just the page on screen.
const cleanupOpen = ref(false);
const cleanupDays = ref(90);
const cleanupPool = ref<Capture[] | null>(null);
const cleanupScan = ref<{ loaded: number; total: number } | null>(null);
const cleanupMsg = ref('');
const cleanupNow = ref(Date.now());
// The cleanup scan looks up its own pool, so what it may trust is separate from the list's state.
// null = no successful lookup of the pool: nothing can qualify.
const cleanupState = ref<UploadStateResult | null>(null);
const cleanupFacts = computed<RowFacts>(() => ({
	...facts.value,
	uploadedKnown: !!cleanupState.value,
	uploaded: cleanupState.value?.uploaded ?? {},
	partial: cleanupState.value?.partial ?? {},
}));
const cleanupList = computed(() =>
	cleanupPool.value ? cleanupCandidates(cleanupPool.value, cleanupFacts.value, cleanupDays.value, cleanupNow.value) : []);
const cleanupSummary = computed(() => summarizeCleanup(cleanupList.value));
const cleanupLeftOut = computed(() => (cleanupPool.value ? cleanupPool.value.length - cleanupList.value.length : 0));
const fmtDay = (mtime: number | null) => (mtime ? new Date(mtime * 1000).toLocaleDateString() : '—');

async function previewCleanup() {
	cleanupPool.value = null;
	cleanupState.value = null;
	cleanupMsg.value = '';
	cleanupNow.value = Date.now();
	const pool: Capture[] = [];
	try {
		cleanupScan.value = { loaded: 0, total: 0 };
		for (;;) {
			const data = await fetchPage(pool.length, { status: 'finalized', sort: 'date_asc', q: '', limit: 500 });
			pool.push(...(data.captures || []));
			cleanupScan.value = { loaded: pool.length, total: data.total };
			if (!data.captures?.length || pool.length >= data.total) break;
		}
		const r = await lookupUploaded(pool);
		if (!r) {
			cleanupMsg.value = 'Cannot tell which captures are uploaded because the database could not be reached. Nothing can be selected for cleanup.';
			return;
		}
		cleanupState.value = r;
		cleanupPool.value = pool;
	} catch (e: any) {
		cleanupMsg.value = describeFetchError(e, 'failed to scan the captures');
	} finally {
		cleanupScan.value = null;
	}
}

async function runCleanup() {
	if (bulk.value || uploadingAll.value || !cleanupPool.value) return;
	const items = cleanupList.value.slice();
	if (!items.length) return;
	const sum = summarizeCleanup(items);
	const ok = await confirmAction({
		title: `Delete ${items.length} uploaded capture${items.length === 1 ? '' : 's'}?`,
		message: `Every one of these is older than ${cleanupDays.value} days and has its analysis and files in the database. Captures that are not uploaded, incomplete, queued or unknown are never included.`,
		detail: 'This cannot be undone. The database records and analyses stay.',
		stats: [
			{ label: 'Captures', value: String(sum.count) },
			{ label: 'Space freed', value: formatMegabytes(sum.totalMb) },
			{ label: 'Recorded between', value: `${fmtDay(sum.oldest)} and ${fmtDay(sum.newest)}` },
		],
		confirmLabel: `Delete ${items.length} permanently`,
		tone: 'danger',
	});
	if (!ok) return;
	// Ask Directus again now, and apply the rule to what it says now rather than to the preview.
	const fresh = await lookupUploaded(items);
	if (!fresh) {
		cleanupMsg.value = 'The database stopped answering, so nothing was deleted.';
		return;
	}
	cleanupState.value = fresh;
	const cutoff = cleanupCutoff(cleanupDays.value, Date.now());
	// Then once more per item, right before its delete: is it still there, is it still fully uploaded
	// (one analysis-row query for its known operation), and is nothing running for it.
	const results = await deleteMany(items, async (c) => {
		const now = await freshRow(c);
		if (!now) return cleanupSkipReason(null, cleanupFacts.value, cutoff);
		const opId = cleanupState.value?.opIds[c.id];
		const complete = opId ? await recheckUploaded(opId, now.hasMat, getRows) : false;
		const f = { ...cleanupFacts.value, uploaded: { ...cleanupFacts.value.uploaded, [c.id]: complete } };
		return cleanupSkipReason(now.row, f, cutoff);
	});
	reportDeletes('Cleanup finished', results);
	cleanupPool.value = null;
	cleanupState.value = null;
	await load();   // re-count from the drive (warm: two stats per capture)
}

// Recover an interrupted recording: the same endpoint the Record page's banner uses. It finalizes
// the raw capture (the original recording config is read back from manifest.json), after which the
// row becomes an ordinary finalized capture (#82).
async function recover(c: Capture) {
	busy.value[c.id] = 'recovering';
	rowMsg.value[c.id] = '';
	try {
		const res = await fetch(`${base()}/recovery/recover/${c.id}`, { method: 'POST' });
		if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.detail || `HTTP ${res.status}`);
		await load();
		rowMsg.value[c.id] = 'recovered';
	} catch (e: any) {
		rowMsg.value[c.id] = `recover failed: ${e?.message || e}`;
	} finally {
		delete busy.value[c.id];
	}
}

function openEdit(c: Capture) { editing.value = c; }
async function onMetadataSaved() {
	const id = editing.value?.id;
	editing.value = null;
	if (!id) return;
	// Refresh just this row's summary-derived fields (sample_name etc.) rather than a full re-scan
	// of every capture on disk — the same data /captures/browse already extracts, straight from the
	// file this dialog just wrote.
	try {
		const res = await fetch(`${base()}/captures/${id}/summary`);
		if (!res.ok) return;
		const s = await res.json();
		const c = captures.value.find((x) => x.id === id);
		if (c) c.sample_name = s.sample_name;
	} catch { /* best effort — Refresh button still works */ }
}

async function upload(c: Capture): Promise<UploadOutcome> {
	if (busy.value[c.id] || bulk.value || !canUpload(c)) return 'skipped';   // never two uploads of one capture
	// Before any prompt: an offline session can't upload, so don't ask the user to confirm something
	// that cannot run.
	if (!hasServerSession()) { rowMsg.value[c.id] = OFFLINE_SESSION_UPLOAD_MESSAGE; return 'failed'; }
	busy.value[c.id] = 'uploading';
	rowMsg.value[c.id] = '';
	try {
		const sum = await fetch(`${base()}/captures/${c.id}/summary`).then((r) => {
			if (!r.ok) throw new Error(`summary: HTTP ${r.status}`);
			return r.json();
		});
		// A capture records who recorded it. If that isn't who is signed in now, make the upload a
		// deliberate choice rather than a quiet re-attribution (the recorder is kept either way).
		const rec = recorderFromExtra(sum.config?.extra_metadata || sum.metadata);
		const me = authStore.state.user?.id;
		if (rec && me && rec.userId !== me) {
			const ok = await confirmAction({
				title: 'Upload someone else\'s capture?',
				message: `"${sum.sample_name || c.id}" was recorded by ${rec.name || rec.email || 'another user'}.`,
				detail: 'It is uploaded with them as its recorder and owner, and logged as uploaded by you.',
				confirmLabel: 'Upload',
			});
			if (!ok) return 'skipped';
		}
		const opId = await uploadCaptureColdStart({
			captureId: c.id,
			matUrl: `${base()}/captures/${c.id}/capture.mat`,
			cacheUrl: `${base()}/captures/${c.id}/live_cache.bin`,
			cfg: sum.config || {},
			peaks: sum.peaks,
			matWritten: sum.mat_written,
			summary: sum,
		});
		// "Uploaded" is the database's answer, not the upload call's: look at the operation's analysis
		// row again and only then show the capture as redundant locally.
		const state = await confirmUploadState(opId, hasMat(c), getRows);
		uploadedOpId.value = { ...uploadedOpId.value, [c.id]: opId };
		if (state === 'uploaded') {
			uploaded.value = { ...uploaded.value, [c.id]: true };
			const { [c.id]: _done, ...stillPartial } = partial.value;
			partial.value = stillPartial;
			rowMsg.value[c.id] = 'uploaded';
			return 'uploaded';
		}
		// The in-memory progress says "done" but the database disagrees (a linked file was removed, or
		// the answer was unknown): forget it so the next upload looks the record up again.
		clearUploadProgress(c.id);
		const { [c.id]: _gone, ...notUploaded } = uploaded.value;
		uploaded.value = notUploaded;
		partial.value = { ...partial.value, [c.id]: true };
		rowMsg.value[c.id] = state === 'partial'
			? 'upload incomplete: the database record is still missing a file - upload again to finish it'
			: 'upload finished but could not be confirmed (database not reachable) - it still counts as not uploaded';
		return 'failed';
	} catch (e: any) {
		rowMsg.value[c.id] = `upload failed: ${e?.message || e}`;
		return 'failed';
	} finally {
		delete busy.value[c.id];
	}
}

// Upload-all runs one capture at a time (each is a multi-MB file upload), shows n of m and the item
// in flight, and stops between items when cancelled: an upload in progress is never cut off.
const uploadRun = ref<UploadProgress | null>(null);
const uploadingAll = computed(() => !!uploadRun.value && !uploadRun.value.finished);
async function uploadAllUnsynced() {
	if (uploadingAll.value || bulk.value) return;
	const pending = unsynced.value.slice();
	if (!pending.length) return;
	if (!hasServerSession()) { error.value = OFFLINE_SESSION_UPLOAD_MESSAGE; return; }
	const ok = await confirmAction({
		title: `Upload ${pending.length} capture${pending.length === 1 ? '' : 's'}?`,
		message: 'Each is sent to the database in turn. Large captures can take a while. You can cancel between captures.',
		confirmLabel: 'Upload',
	});
	if (!ok) return;
	uploadRun.value = startUploadProgress(pending.length);
	for (const c of pending) {
		if (shouldStopUploads(uploadRun.value!)) break;
		// State may have moved while earlier items uploaded (a queue sync, a delete).
		if (!captures.value.some((x) => x.id === c.id) || !canUpload(c)) { uploadRun.value = finishUploadItem(uploadRun.value!, 'skipped'); continue; }
		uploadRun.value = beginUploadItem(uploadRun.value!, c.sample_name || c.id);
		const outcome = await upload(c);
		uploadRun.value = finishUploadItem(uploadRun.value!, outcome);
	}
	uploadRun.value = finishUploads(uploadRun.value!);
}
function cancelUploadAll() {
	if (uploadRun.value && !uploadRun.value.finished) uploadRun.value = requestUploadCancel(uploadRun.value);
}
// #96: where a capture's files are. "Show in folder" needs the desktop app and a local recorder;
// copying the path works everywhere.
const canReveal = canRevealPaths();
const rootMsg = ref('');
async function copyPath(p: string, rowId?: string) {
	const msg = (await copyText(p)) ? 'path copied' : 'copy failed: the clipboard is not available here';
	if (rowId) rowMsg.value[rowId] = msg;
	else rootMsg.value = msg;
}
async function showInFolder(p: string, rowId?: string) {
	const err = await revealPath(p);
	const msg = err ? `show in folder failed: ${err}` : '';
	if (rowId) rowMsg.value[rowId] = msg;
	else rootMsg.value = msg;
}

function fmtDate(mtime: number): string {
	if (!mtime) return '—';
	return new Date(mtime * 1000).toLocaleString();
}

// ---- Pending run-record uploads ----
// The offline queue (directusSync) retries in the background, but a permanent failure — a
// validation or permission error — parks an item forever behind a topbar count with no way to see
// which run, why, or to clear it. flush() also stops at the first such failure, so one poisoned
// item blocks everything behind it.
const queue = ref<QueuedRun[]>([]);
const queueBusy = ref<string | null>(null);
function refreshQueue() { queue.value = listQueue(); }

// uploadCaptureColdStart has no idempotency guard: running it twice creates a SECOND
// manufacturing_operations row plus a second analysis record, and re-sends the multi-MB files. So
// an upload is only offered when we positively know one hasn't happened. Two states must suppress
// it — an unknown upload state (Directus unreachable, so `uploaded` is empty, which is NOT the
// same as "nothing is uploaded"), and a run still in the offline queue, which will be written by
// itself as soon as the connection returns.
const queuedCaptureIds = computed(
	() => new Set(queue.value.map((q) => q.payload?.recorded_metadata?.capture_id).filter(Boolean)),
);
// Also false while anything is already running for the row, so Upload all cannot start a second
// upload of a capture whose own Upload button was just pressed (that would make a second run).
function canUpload(c: Capture): boolean {
	return canUploadCapture(c, facts.value);
}
const unsynced = computed(() => captures.value.filter(canUpload));

async function retryOne(id: string) {
	queueBusy.value = id;
	try {
		// false = a background sync already held the lock, so nothing was attempted now. Say so
		// rather than letting the row look as though it had been retried and failed again.
		const attempted = await retryQueued(id);
		if (!attempted) rowMsg.value[id] = 'a sync is already running — this run is next in line';
	} finally { queueBusy.value = null; refreshQueue(); }
}
// A queued record recorded by someone else only uploads automatically when THEY sign in. This is
// the deliberate override: it still carries the recorder's name and owner, and is logged as
// synced by whoever is signed in now.
const waitingForOther = (item: QueuedRun) =>
	!!item.recordedBy && item.recordedBy !== authStore.state.user?.id && !item.syncAsMe;
async function uploadAsMe(item: QueuedRun) {
	if (!hasServerSession()) { rowMsg.value[item.id] = OFFLINE_SESSION_UPLOAD_MESSAGE; return; }
	const ok = await confirmAction({
		title: 'Upload someone else\'s record?',
		message: `"${queueLabel(item)}" was recorded by ${item.recordedByLabel || 'another user'}.`,
		detail: 'It is uploaded with them as its recorder and owner, and logged as uploaded by you.',
		confirmLabel: 'Upload as me',
	});
	if (!ok) return;
	queueBusy.value = item.id;
	try { await uploadQueuedAsMe(item.id); } finally { queueBusy.value = null; refreshQueue(); }
}
async function discardOne(item: QueuedRun) {
	const name = item.payload?.recorded_metadata?.sample_name || item.payload?.recorded_metadata?.capture_id || item.id;
	const ok = await confirmAction({
		title: 'Discard this queued database record?',
		message: `The pending database write for "${name}" is abandoned.`,
		detail: 'The recording itself stays on disk — only the database record is dropped. You can upload it again later from Captures.',
		confirmLabel: 'Discard record',
		tone: 'danger',
	});
	if (!ok) return;
	discardQueued(item.id);
	refreshQueue();
}
function queueLabel(item: QueuedRun): string {
	const rm = item.payload?.recorded_metadata || {};
	return rm.sample_name || rm.capture_id || item.collection;
}

const route = useRoute();
// Read the wanted focus now, synchronously at setup: ui/focusLink.ts strips `?focus=` from the URL
// after its 2 s wait, so on a slow /captures/browse the query is already gone by the time load()
// resolves and checking it afterwards would never spotlight.
const wantedFocus = focusIdFrom(route.query);
onMounted(async () => {
	// The Doctor's link points at incomplete captures, which may be pages down a date-sorted list.
	if (wantedFocus === 'incomplete-captures') statusFilter.value = 'incomplete';
	refreshQueue();
	await load();
	// Arrived from the Connectivity doctor's "Open Local Captures": point at the incomplete rows.
	if (wantedFocus === 'incomplete-captures') {
		await nextTick();
		spotlight('incomplete-captures', { focus: false });
	}
});
</script>

<template>
	<div class="caps">
		<h2>Local Captures</h2>
		<p class="lead">
			Every recording stored on this machine. Recordings stay on disk even when you choose not to
			save them, so this is where to reclaim space — and to re-upload anything that never made it
			to the database.
		</p>

		<div class="summary">
			<div class="stat">
				<span>Captures</span>
				<b>{{ totalAll }}</b>
			</div>
			<div class="stat">
				<span>{{ matchingMb != null ? 'Using (matching)' : 'Using (loaded)' }}</span>
				<b>{{ formatMegabytes(matchingMb ?? loadedMb) }}</b>
			</div>
			<div class="stat" v-if="disk.free_gb != null">
				<span>Free on drive</span><b>{{ disk.free_gb.toFixed(1) }} GB</b>
			</div>
			<div class="spacer"></div>
			<button class="btn" :disabled="loading" @click="load">
				<span class="material-symbols-rounded">{{ loading ? 'hourglass_top' : 'refresh' }}</span>
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
			<button v-if="unsynced.length && !uploadingAll" class="btn primary" :disabled="!!bulk" :title="bulk ? 'A delete is running' : 'Counts the captures loaded below'" @click="uploadAllUnsynced">
				<span class="material-symbols-rounded">cloud_upload</span>
				Upload {{ unsynced.length }} unsynced
			</button>
			<button class="btn" :class="{ primary: cleanupOpen }" @click="cleanupOpen = !cleanupOpen">
				<span class="material-symbols-rounded">cleaning_services</span>
				Free up space
			</button>
		</div>

		<div v-if="uploadRun" class="progress" role="status">
			<span class="material-symbols-rounded" :class="{ spin: uploadingAll }">{{ uploadingAll ? 'progress_activity' : 'cloud_done' }}</span>
			<span class="ptext">{{ uploadProgressText(uploadRun) }}</span>
			<progress :max="uploadRun.total" :value="uploadRun.done"></progress>
			<button v-if="uploadingAll" class="btn sm" :disabled="uploadRun.cancelRequested" @click="cancelUploadAll">Cancel</button>
			<button v-else class="btn sm quiet" @click="uploadRun = null">Dismiss</button>
		</div>

		<div v-if="cleanupOpen" class="cleanup">
			<h3>Free up space</h3>
			<p class="hint sub">
				Deletes captures that are already uploaded to the database and older than a number of days.
				Captures that are not uploaded, incomplete, queued for upload or of unknown state are never
				included. You see the list before anything is deleted.
			</p>
			<div class="crow">
				<label>Older than
					<input type="number" min="0" max="3650" v-model.number="cleanupDays" class="days" :disabled="!!bulk" />
					days
				</label>
				<button class="btn" :disabled="!!cleanupScan || !!bulk || uploadingAll" @click="previewCleanup">
					<span class="material-symbols-rounded">{{ cleanupScan ? 'hourglass_top' : 'search' }}</span>
					{{ cleanupScan ? `Scanning ${cleanupScan.loaded} of ${cleanupScan.total || '…'}` : cleanupPool ? 'Scan again' : 'Preview' }}
				</button>
			</div>
			<p v-if="cleanupMsg" class="err">{{ cleanupMsg }}</p>
			<template v-if="cleanupPool">
				<p v-if="cleanupSummary.count" class="cres">
					<b>{{ cleanupSummary.count }}</b> uploaded capture{{ cleanupSummary.count === 1 ? '' : 's' }} older than
					{{ cleanupDays }} days, <b>{{ formatMegabytes(cleanupSummary.totalMb) }}</b>,
					recorded {{ fmtDay(cleanupSummary.oldest) }} to {{ fmtDay(cleanupSummary.newest) }}.
					<span class="hint">{{ cleanupLeftOut }} other finalized capture{{ cleanupLeftOut === 1 ? '' : 's' }} kept (newer, or not uploaded).</span>
				</p>
				<p v-else class="cres">Nothing to clean up: no uploaded capture is older than {{ cleanupDays }} days.
					<span class="hint">{{ cleanupPool.length }} finalized capture{{ cleanupPool.length === 1 ? '' : 's' }} checked.</span></p>
				<ul v-if="cleanupSummary.count" class="clist">
					<li v-for="c in cleanupList.slice(0, 8)" :key="c.id">
						<span>{{ c.sample_name || c.id }}</span><span class="hint">{{ fmtDay(c.mtime) }}, {{ formatMegabytes(c.size_mb) }}</span>
					</li>
					<li v-if="cleanupList.length > 8" class="hint">…and {{ cleanupList.length - 8 }} more</li>
				</ul>
				<button v-if="cleanupSummary.count" class="btn danger" :disabled="!!bulk" @click="runCleanup">
					<span class="material-symbols-rounded">delete_sweep</span>
					Delete {{ cleanupSummary.count }} capture{{ cleanupSummary.count === 1 ? '' : 's' }}…
				</button>
			</template>
		</div>

		<div v-if="bulk" class="progress" role="status">
			<span class="material-symbols-rounded spin">progress_activity</span>
			<span class="ptext">Deleting {{ Math.min(bulk.done + 1, bulk.total) }} of {{ bulk.total }}: {{ bulk.current }}</span>
			<progress :max="bulk.total" :value="bulk.done"></progress>
			<button class="btn sm" :disabled="bulk.cancel" @click="cancelBulk">{{ bulk.cancel ? 'Cancelling…' : 'Cancel' }}</button>
		</div>
		<div v-if="bulkReport" class="report" role="status">
			<div class="rhead"><b>{{ bulkReport.title }}</b><span>{{ bulkReport.text }}</span>
				<button class="btn sm quiet" @click="bulkReport = null">Dismiss</button></div>
			<ul v-if="bulkReport.problems.length" class="clist"><li v-for="(p, i) in bulkReport.problems" :key="i" class="bad">{{ p }}</li></ul>
		</div>

		<div class="hint path" v-if="capturesRoot">
			<span>{{ capturesRoot }}</span>
			<button class="iconbtn" title="Copy path" aria-label="Copy path" @click="copyPath(capturesRoot)">
				<span class="material-symbols-rounded">content_copy</span>
			</button>
			<button v-if="canReveal" class="iconbtn" title="Show in folder" aria-label="Show in folder" @click="showInFolder(capturesRoot)">
				<span class="material-symbols-rounded">folder_open</span>
			</button>
			<span v-if="rootMsg" class="pathmsg" :class="{ bad: rootMsg.includes('failed') }">{{ rootMsg }}</span>
		</div>

		<p v-if="error" class="err">{{ error }}</p>

		<!-- Pending run-record writes. Hidden entirely when the queue is empty, which is the
			 normal state — this only needs to exist when something is actually stuck. -->
		<template v-if="queue.length">
			<h3>Pending database records <span class="chip">{{ queue.length }}</span></h3>
			<p class="hint sub">
				Run records waiting to be written to the database. These retry automatically; an item with
				an error needs attention, and blocks the ones behind it until it is retried or discarded.
			</p>
			<div v-for="item in queue" :key="item.id" class="row qrow">
				<div class="rmain">
					<div class="rtop">
						<span class="rname">{{ queueLabel(item) }}</span>
						<span v-if="item.lastError" class="tag warn">error</span>
						<span v-else-if="waitingForOther(item)" class="tag warn">waiting for {{ item.recordedByLabel || 'recorder' }}</span>
						<span v-else class="tag">queued</span>
					</div>
					<div class="rsub">
						<span>{{ item.collection }}</span>
						<span v-if="item.recordedByLabel">recorded by {{ item.recordedByLabel }}</span>
						<span v-if="item.attempts">{{ item.attempts }} attempt<span v-if="item.attempts !== 1">s</span></span>
						<span>{{ new Date(item.createdAt).toLocaleString() }}</span>
					</div>
					<p v-if="rowMsg[item.id]" class="rmsg">{{ rowMsg[item.id] }}</p>
					<p v-if="item.lastError" class="rmsg bad">{{ item.lastError }}</p>
				</div>
				<div class="ract">
					<button v-if="waitingForOther(item)" class="btn sm" :disabled="queueBusy === item.id" title="Recorded by another user: uploads by itself when they sign in" @click="uploadAsMe(item)">
						<span class="material-symbols-rounded">cloud_upload</span>Upload as me
					</button>
					<button v-else class="btn sm" :disabled="queueBusy === item.id" @click="retryOne(item.id)">
						<span class="material-symbols-rounded">{{ queueBusy === item.id ? 'hourglass_top' : 'refresh' }}</span>
						{{ queueBusy === item.id ? 'Retrying…' : 'Retry' }}
					</button>
					<button class="btn sm danger quiet" :disabled="queueBusy === item.id" @click="discardOne(item)">
						<span class="material-symbols-rounded">delete</span>Discard
					</button>
				</div>
			</div>
			<p v-if="syncStatus.lastError" class="err">{{ syncStatus.lastError }}</p>
			<h3>Recordings on disk</h3>
		</template>

		<div class="toolbar">
			<input
				v-model="query" type="search" class="search" placeholder="Search sample, date or id"
				aria-label="Search captures" @input="onSearchInput"
			/>
			<div class="chips" role="group" aria-label="Filter by status">
				<button
					v-for="f in FILTERS" :key="f.key" class="fchip" :class="{ on: statusFilter === f.key }"
					:aria-pressed="statusFilter === f.key" @click="setFilter(f.key)"
				>{{ f.label }}</button>
			</div>
			<label class="sortsel">Sort
				<select v-model="sortKey" aria-label="Sort captures" @change="load">
					<option value="date_desc">Newest first</option>
					<option value="date_asc">Oldest first</option>
					<option value="size_desc">Largest first</option>
					<option value="size_asc">Smallest first</option>
				</select>
			</label>
		</div>
		<div class="bulkbar" v-if="visible.length">
			<label class="selall" :title="bulkBlock || ''">
				<input type="checkbox" :checked="allShownSelected" :disabled="!selectableCount || !!bulk" @change="toggleAllShown" />
				Select all shown
			</label>
			<template v-if="selected.size">
				<span class="hint">{{ selected.size }} selected, {{ formatMegabytes(selectedMb) }}</span>
				<button class="btn sm danger" :disabled="!!bulkBlock || !!bulk || uploadingAll" :title="bulkBlock || (uploadingAll ? 'Upload all is running' : '')" @click="deleteSelected">
					<span class="material-symbols-rounded">delete</span>Delete selected…
				</button>
				<button class="btn sm quiet" @click="selected = new Set()">Clear</button>
			</template>
			<span v-else class="hint">Incomplete captures are deleted one at a time.</span>
		</div>

		<div v-if="!loading && !visible.length" class="empty">
			{{ captures.length || query || statusFilter !== 'all' ? 'No captures match.' : 'No recordings on this machine.' }}
		</div>

		<div v-for="c in visible" :key="c.id" class="row" :class="{ picked: selected.has(c.id) }" :data-focus="!c.finalized ? 'incomplete-captures' : undefined">
			<input
				type="checkbox" class="pick" :checked="selected.has(c.id)" :disabled="!isBulkSelectable(c, facts) || !!bulk"
				:aria-label="`Select ${c.sample_name || c.id}`"
				:title="isBulkSelectable(c, facts) ? '' : c.finalized ? 'Busy right now' : 'Incomplete captures are deleted one at a time'"
				@change="toggleRow(c.id)"
			/>
			<div class="rmain">
				<div class="rtop">
					<span
						class="rname" :class="{ clickable: c.finalized }"
						:title="c.finalized ? 'Click to edit this capture\'s metadata' : ''"
						@click="c.finalized && openEdit(c)"
					>{{ c.sample_name || c.id }}</span>
					<span v-if="!c.finalized" class="tag warn" title="No summary.json — this recording was never finalized. Recover it to keep the data.">incomplete</span>
					<span v-else-if="!uploadedKnown" class="tag">upload state unknown</span>
					<span v-else-if="uploaded[c.id]" class="tag ok">uploaded</span>
					<span v-else-if="queuedCaptureIds.has(c.id)" class="tag">upload queued</span>
					<span v-else-if="partial[c.id]" class="tag warn" title="A database record exists but the upload never finished (files or analysis missing). This is still the only complete copy: upload it again to finish.">partial upload</span>
					<span v-else class="tag warn">not uploaded</span>
					<!-- Not part of the chain above: these say something else about the row. -->
					<span v-if="c.recording" class="tag">recording now</span>
					<span v-if="c.recovering && busy[c.id] !== 'recovering'" class="tag warn" title="A recover or restore is working on this recording right now">recovering</span>
					<span v-if="remoteState(c.id)" class="tag" :class="remoteState(c.id) === 'complete' ? 'ok' : 'warn'"
						:title="remoteState(c.id) === 'complete' ? 'A full copy of this recording is on the remote backup server' : 'Only the part of this recording that was streamed before the backup was interrupted is on the remote backup server'">{{ remoteState(c.id) === 'complete' ? 'also backed up remotely' : remoteCopyLabel(remoteState(c.id)) }}</span>
					<span v-if="c.source" class="tag dim">{{ c.source }}</span>
				</div>
				<div class="rsub">
					<span class="mono">{{ c.id }}</span>
					<span>{{ formatMegabytes(c.size_mb) }}</span>
					<span v-if="c.duration_sec != null">{{ c.duration_sec.toFixed(1) }}s</span>
					<span v-if="c.n">{{ c.n.toLocaleString() }} samples</span>
					<span>{{ fmtDate(c.mtime) }}</span>
				</div>
				<div v-if="c.dir" class="rpath">
					<span class="mono" :title="c.dir">{{ c.dir }}</span>
					<button class="iconbtn" title="Copy path" aria-label="Copy path" @click="copyPath(c.dir, c.id)">
						<span class="material-symbols-rounded">content_copy</span>
					</button>
					<button v-if="canReveal" class="iconbtn" title="Show in folder" aria-label="Show in folder" @click="showInFolder(c.dir, c.id)">
						<span class="material-symbols-rounded">folder_open</span>
					</button>
				</div>
				<p v-if="rowMsg[c.id]" class="rmsg" :class="{ bad: rowMsg[c.id].includes('failed') }">{{ rowMsg[c.id] }}</p>
			</div>
			<div class="ract">
				<button v-if="c.finalized" class="btn sm" :disabled="!!busy[c.id]" @click="openEdit(c)">
					<span class="material-symbols-rounded">edit</span>Edit
				</button>
				<button v-if="!c.finalized && c.recoverable && !c.recording && !c.discarding" class="btn sm success" :disabled="!!busy[c.id] || c.recovering" :title="c.recovering ? 'A recover or restore is already running for this recording' : 'Finalize this interrupted recording so it can be used'" @click="recover(c)">
					<span class="material-symbols-rounded" :class="{ spin: busy[c.id] === 'recovering' }">{{ busy[c.id] === 'recovering' ? 'progress_activity' : 'healing' }}</span>
					{{ busy[c.id] === 'recovering' ? 'Recovering…' : 'Recover' }}
				</button>
				<button v-if="canUpload(c) || busy[c.id] === 'uploading'" class="btn sm" :disabled="!!busy[c.id] || uploadingAll || !!bulk" :title="uploadingAll ? 'Upload all is running' : bulk ? 'A delete is running' : ''" @click="upload(c)">
					<span class="material-symbols-rounded">{{ busy[c.id] === 'uploading' ? 'hourglass_top' : 'cloud_upload' }}</span>
					{{ busy[c.id] === 'uploading' ? 'Uploading…' : 'Upload' }}
				</button>
				<button class="btn sm danger quiet" :disabled="!!busy[c.id] || c.recording || c.discarding || c.recovering" :title="c.recovering ? 'Can\'t delete while a recover or restore is running — wait for it to finish' : c.recording ? 'Can\'t delete the recording in progress' : c.discarding ? 'Already being deleted' : ''" @click="remove(c)">
					<span class="material-symbols-rounded">{{ busy[c.id] === 'deleting' ? 'hourglass_top' : 'delete' }}</span>
					{{ busy[c.id] === 'deleting' ? 'Deleting…' : 'Delete' }}
				</button>
			</div>
		</div>

		<div v-if="captures.length || total" class="foot">
			<span class="hint">
				Showing {{ visible.length }} of {{ total }}
				<template v-if="isClientFilter(statusFilter) && visible.length !== captures.length"> ({{ captures.length }} checked)</template>
				<template v-if="total !== totalAll"> · {{ totalAll }} on disk</template>
			</span>
			<button v-if="captures.length < total" class="btn sm" :disabled="loadingMore || loading" @click="loadMore">
				<span class="material-symbols-rounded">{{ loadingMore ? 'hourglass_top' : 'expand_more' }}</span>
				{{ loadingMore ? 'Loading…' : `Load more (${Math.min(pageSizeFor(statusFilter, PAGE, MAX_PAGE), total - captures.length)} of ${total - captures.length} left)` }}
			</button>
		</div>

		<EditCaptureMetadataDialog
			v-if="editing"
			:capture-id="editing.id"
			:operation-id="uploadedOpId[editing.id] || null"
			@close="editing = null"
			@saved="onMetadataSaved"
		/>
	</div>
</template>

<style scoped>
.caps { max-width: 820px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); }
.path { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 6px 0 14px; font-family: var(--mono); word-break: break-all; }
.pathmsg { font-family: var(--font); color: var(--ok); margin-left: 4px; }
.pathmsg.bad { color: var(--danger); }
.rpath { display: flex; align-items: center; gap: 2px; margin-top: 3px; min-width: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.rpath .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.iconbtn { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 0;
	color: var(--text-dim); background: none; border: 0; border-radius: 6px; cursor: pointer; }
.iconbtn:hover { color: var(--text); background: var(--surface-2); }
.iconbtn .material-symbols-rounded { font-size: var(--icon-xs); }
.err { color: var(--danger); font-size: var(--fs-sm); }
.summary { display: flex; align-items: flex-end; gap: 22px; padding: 12px 14px;
	background: var(--surface); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat span { font-size: var(--fs-xs); color: var(--text-dim); }
.stat b { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.row { display: flex; align-items: center; gap: 12px; padding: 11px 13px; margin-top: 8px;
	background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.rmain { flex: 1; min-width: 0; }
.rtop { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.rname { font-size: var(--fs-md); font-weight: 600; }
.rname.clickable { cursor: pointer; }
.rname.clickable:hover { color: var(--accent); text-decoration: underline; }
.rsub { display: flex; gap: 12px; margin-top: 3px; font-size: var(--fs-sm); color: var(--text-dim);
	flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); }
.tag { font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
	padding: 1px 7px; border-radius: 99px; color: var(--text-dim); background: var(--surface-2); }
.tag.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.tag.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
.tag.dim { opacity: 0.7; }
.ract { display: flex; gap: 7px; flex-shrink: 0; }
.rmsg { margin: 5px 0 0; font-size: var(--fs-sm); color: var(--ok); }
.rmsg.bad { color: var(--danger); }
.empty { padding: 26px; text-align: center; color: var(--text-dim); font-size: var(--fs-md);
	border: 1px dashed var(--border); border-radius: 10px; margin-top: 10px; }
h3 { margin: 24px 0 4px; font-size: var(--fs-lg); display: flex; align-items: center; gap: 8px; }
.chip { font-size: var(--fs-xs); font-weight: 700; color: var(--accent-ink); background: var(--accent);
	padding: 1px 7px; border-radius: 99px; }
.sub { margin: 0 0 8px; line-height: 1.45; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.search { flex: 1; min-width: 200px; padding: 7px 10px; font: inherit; font-size: var(--fs-md); color: var(--text);
	background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.fchip { font: inherit; font-size: var(--fs-sm); padding: 4px 11px; border-radius: 99px; cursor: pointer;
	color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); }
.fchip:hover { color: var(--text); }
.fchip.on { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.sortsel { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-dim); }
.sortsel select { font: inherit; padding: 5px 8px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.bulkbar { display: flex; align-items: center; gap: 12px; margin-top: 10px; min-height: 30px; flex-wrap: wrap; }
.selall { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-dim); cursor: pointer; }
.pick { flex-shrink: 0; width: 16px; height: 16px; cursor: pointer; }
.row.picked { border-color: var(--accent); }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.progress { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 9px 13px; flex-wrap: wrap;
	background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.progress .ptext { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.progress progress { flex: 1; min-width: 120px; accent-color: var(--accent); }
.cleanup { margin-top: 10px; padding: 4px 14px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.cleanup h3 { margin-top: 12px; }
.crow { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: var(--fs-md); }
.days { width: 70px; padding: 5px 8px; font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; }
.cres { margin: 10px 0 6px; font-size: var(--fs-md); }
.clist { margin: 4px 0 10px; padding-left: 18px; font-size: var(--fs-sm); }
.clist li { display: flex; gap: 10px; justify-content: space-between; }
.clist li.bad { color: var(--danger); }
.report { margin-top: 10px; padding: 9px 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; font-size: var(--fs-sm); }
.rhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.qrow { border-color: color-mix(in srgb, var(--warn) 28%, transparent); }
</style>
