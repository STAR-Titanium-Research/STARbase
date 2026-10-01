<script setup lang="ts">
// Local capture housekeeping. Captures accumulate on the recording drive indefinitely: "Don't
// save" deliberately leaves the raw on disk, and recovery.discard_session refuses to touch
// finalized sessions — so until now nothing in the app could show what was there, let alone
// remove it. This lists everything with sizes and upload state, and can delete or re-upload.
import { computed, onMounted, ref } from 'vue';
import { getConfig } from '../config';
import { api } from '../directusClient';
import { uploadCaptureColdStart } from '../record/uploadCapture';
import { discardQueued, listQueue, retryQueued, syncStatus, uploadQueuedAsMe, type QueuedRun } from '../record/directusSync';
import { authStore } from '../authStore';
import { OFFLINE_SESSION_UPLOAD_MESSAGE, hasServerSession, recorderFromExtra } from '../recorder';
import { confirmAction } from '../ui/confirm';
import EditCaptureMetadataDialog from './EditCaptureMetadataDialog.vue';
import { matchUploaded, uploadedRowsSince } from './captureUploadState';
import { formatMegabytes } from '../format';

interface Capture {
	id: string;
	size_mb: number;
	finalized: boolean;
	files: Record<string, number>;
	mtime: number;
	sample_name?: string;
	duration_sec?: number;
	n?: number;
	peaks?: { Fx: number; Fy: number; Fz: number };
	source?: string;
}

const base = () => getConfig().recorderUrl;

const captures = ref<Capture[]>([]);
const capturesRoot = ref('');
const totalMb = ref(0);
const disk = ref<{ free_gb?: number; total_gb?: number }>({});
const loading = ref(false);
const error = ref('');
const busy = ref<Record<string, string>>({});   // id -> 'deleting' | 'uploading'
const rowMsg = ref<Record<string, string>>({});
// Which captures already exist in Directus. Looked up once per load so the list can distinguish
// "safe to delete, it's in the database" from "this is the only copy".
const uploaded = ref<Record<string, boolean>>({});
// capture_id -> operation_id, for the metadata editor: present means "PATCH the Directus row too,
// not just the local summary.json".
const uploadedOpId = ref<Record<string, string>>({});
const uploadedKnown = ref(false);
const editing = ref<Capture | null>(null);

async function load() {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch(`${base()}/captures/browse?limit=500`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		captures.value = data.captures || [];
		capturesRoot.value = data.captures_root || '';
		totalMb.value = data.total_size_mb || 0;
		disk.value = data.disk || {};
		void checkUploaded();
	} catch (e: any) {
		error.value = /failed to fetch|load failed|networkerror/i.test(e?.message || '')
			? "can't reach the recording backend — is it running?"
			: e?.message || 'failed to list captures';
	} finally {
		loading.value = false;
	}
}

async function checkUploaded() {
	// recorded_metadata.capture_id is what both upload paths stamp (workspace.ts and
	// uploadCapture.ts), so it is the link back from a local capture to its database row. Directus
	// can't filter on that JSON key, so candidate rows are fetched and matched client-side (see
	// captureUploadState.ts for why the created_at bound is safe).
	uploadedKnown.value = false;
	try {
		const ids = captures.value.map((c) => c.id);
		if (!ids.length) { uploadedKnown.value = true; return; }
		const since = uploadedRowsSince(ids);
		const res = await api.get('/items/manufacturing_operations', {
			params: {
				filter: { recorded_metadata: { _nnull: true }, ...(since ? { created_at: { _gte: since } } : {}) },
				fields: ['operation_id', 'recorded_metadata'], limit: -1,
			},
		});
		const { uploaded: found, opIds } = matchUploaded(res.data?.data ?? [], ids);
		uploaded.value = found;
		uploadedOpId.value = opIds;
		uploadedKnown.value = true;
	} catch {
		// Offline or not permitted — leave the state unknown rather than claiming "not uploaded",
		// which would invite deleting the only copy of a capture that is in fact safe.
		uploadedKnown.value = false;
	}
}

async function remove(c: Capture) {
	const known = uploadedKnown.value;
	const isUp = !!uploaded.value[c.id];
	const warning = isUp
		? 'It has been uploaded to the database, so the analysis record will remain.'
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
		],
		confirmLabel: 'Delete permanently',
		tone: 'danger',
	});
	if (!ok) return;
	busy.value[c.id] = 'deleting';
	rowMsg.value[c.id] = '';
	try {
		const res = await fetch(`${base()}/captures/${c.id}`, { method: 'DELETE' });
		if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.detail || `HTTP ${res.status}`);
		captures.value = captures.value.filter((x) => x.id !== c.id);
		totalMb.value = Math.max(0, Number((totalMb.value - c.size_mb).toFixed(2)));
	} catch (e: any) {
		rowMsg.value[c.id] = `delete failed: ${e?.message || e}`;
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

async function upload(c: Capture) {
	// Before any prompt: an offline session can't upload, so don't ask the user to confirm something
	// that cannot run.
	if (!hasServerSession()) { rowMsg.value[c.id] = OFFLINE_SESSION_UPLOAD_MESSAGE; return; }
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
			if (!ok) return;
		}
		await uploadCaptureColdStart({
			captureId: c.id,
			matUrl: `${base()}/captures/${c.id}/capture.mat`,
			cacheUrl: `${base()}/captures/${c.id}/live_cache.bin`,
			cfg: sum.config || {},
			peaks: sum.peaks,
			matWritten: sum.mat_written,
		});
		uploaded.value = { ...uploaded.value, [c.id]: true };
		rowMsg.value[c.id] = 'uploaded';
	} catch (e: any) {
		rowMsg.value[c.id] = `upload failed: ${e?.message || e}`;
	} finally {
		delete busy.value[c.id];
	}
}

async function uploadAllUnsynced() {
	const pending = unsynced.value.slice();
	if (!pending.length) return;
	if (!hasServerSession()) { error.value = OFFLINE_SESSION_UPLOAD_MESSAGE; return; }
	const ok = await confirmAction({
		title: `Upload ${pending.length} capture${pending.length === 1 ? '' : 's'}?`,
		message: 'Each is sent to the database in turn. Large captures can take a while.',
		confirmLabel: 'Upload',
	});
	if (!ok) return;
	for (const c of pending) await upload(c);   // sequential: each is a multi-MB file upload
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
function canUpload(c: Capture): boolean {
	return c.finalized && uploadedKnown.value
		&& !uploaded.value[c.id] && !queuedCaptureIds.value.has(c.id);
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

onMounted(() => { load(); refreshQueue(); });
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
			<div class="stat"><span>Captures</span><b>{{ captures.length }}</b></div>
			<div class="stat"><span>Using</span><b>{{ formatMegabytes(totalMb) }}</b></div>
			<div class="stat" v-if="disk.free_gb != null">
				<span>Free on drive</span><b>{{ disk.free_gb.toFixed(1) }} GB</b>
			</div>
			<div class="spacer"></div>
			<button class="btn" :disabled="loading" @click="load">
				<span class="material-symbols-rounded">{{ loading ? 'hourglass_top' : 'refresh' }}</span>
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
			<button v-if="unsynced.length" class="btn primary" @click="uploadAllUnsynced">
				<span class="material-symbols-rounded">cloud_upload</span>
				Upload {{ unsynced.length }} unsynced
			</button>
		</div>
		<p class="hint path" v-if="capturesRoot">{{ capturesRoot }}</p>

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

		<div v-if="!loading && !captures.length" class="empty">No recordings on this machine.</div>

		<div v-for="c in captures" :key="c.id" class="row">
			<div class="rmain">
				<div class="rtop">
					<span
						class="rname" :class="{ clickable: c.finalized }"
						:title="c.finalized ? 'Click to edit this capture\'s metadata' : ''"
						@click="c.finalized && openEdit(c)"
					>{{ c.sample_name || c.id }}</span>
					<span v-if="!c.finalized" class="tag warn" title="No summary.json — this recording was never finalized">incomplete</span>
					<span v-else-if="!uploadedKnown" class="tag">upload state unknown</span>
					<span v-else-if="uploaded[c.id]" class="tag ok">uploaded</span>
					<span v-else-if="queuedCaptureIds.has(c.id)" class="tag">upload queued</span>
					<span v-else class="tag warn">not uploaded</span>
					<span v-if="c.source" class="tag dim">{{ c.source }}</span>
				</div>
				<div class="rsub">
					<span class="mono">{{ c.id }}</span>
					<span>{{ formatMegabytes(c.size_mb) }}</span>
					<span v-if="c.duration_sec != null">{{ c.duration_sec.toFixed(1) }}s</span>
					<span v-if="c.n">{{ c.n.toLocaleString() }} samples</span>
					<span>{{ fmtDate(c.mtime) }}</span>
				</div>
				<p v-if="rowMsg[c.id]" class="rmsg" :class="{ bad: rowMsg[c.id].includes('failed') }">{{ rowMsg[c.id] }}</p>
			</div>
			<div class="ract">
				<button v-if="c.finalized" class="btn sm" :disabled="!!busy[c.id]" @click="openEdit(c)">
					<span class="material-symbols-rounded">edit</span>Edit
				</button>
				<button v-if="canUpload(c)" class="btn sm" :disabled="!!busy[c.id]" @click="upload(c)">
					<span class="material-symbols-rounded">{{ busy[c.id] === 'uploading' ? 'hourglass_top' : 'cloud_upload' }}</span>
					{{ busy[c.id] === 'uploading' ? 'Uploading…' : 'Upload' }}
				</button>
				<button class="btn sm danger quiet" :disabled="!!busy[c.id]" @click="remove(c)">
					<span class="material-symbols-rounded">{{ busy[c.id] === 'deleting' ? 'hourglass_top' : 'delete' }}</span>
					{{ busy[c.id] === 'deleting' ? 'Deleting…' : 'Delete' }}
				</button>
			</div>
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
.path { margin: 6px 0 14px; font-family: var(--mono); word-break: break-all; }
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
.qrow { border-color: color-mix(in srgb, var(--warn) 28%, transparent); }
</style>
