<script setup lang="ts">
// End-of-cut save routine: appears once a recording finishes (manual stop or auto-stop, e.g. disk
// full). Shows the full finished force trace, lets the user upload to the database (pre-ticked
// when online) and/or save locally as .mat/.csv, or explicitly discard (double-confirmed since it's
// the only destructive-feeling path — the raw capture stays on disk regardless, only the database
// write and any local export are skipped).
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useWorkspace } from '../workspace';
import { RAW_BYTES_PER_SAMPLE, RAW_COLUMNS } from '../liveClient';
import FinishedForcePlot from '../FinishedForcePlot.vue';
import { useDialog } from '../../ui/useDialog';
import { formatMegabytes } from '../../format';
import { authStore } from '../../authStore';
import { describeRecordingFailure } from '../recordingErrors';
import { spotlight } from '../../ui/spotlight';

const w = useWorkspace();
const router = useRouter();

const online = ref(navigator.onLine);
// Removed on unmount: these used to be added at setup and never removed, one more pair for every
// recording's dialog for as long as the window stayed open.
const setOnline = () => { online.value = true; };
const setOffline = () => { online.value = false; };
window.addEventListener('online', setOnline);
window.addEventListener('offline', setOffline);
onBeforeUnmount(() => { window.removeEventListener('online', setOnline); window.removeEventListener('offline', setOffline); });

// No Escape: this dialog is a decision (save or discard), not something to dismiss by accident.
const panel = ref<HTMLElement | null>(null);
useDialog(panel);

// manufacturing_operations.sample_id is NOT NULL, and buildRunPayload sends `sampleId || null`, so
// uploading without a Sample picked fails on a raw Directus constraint error at the end of the save
// — after the user has already committed to it. Gate the option on having one instead.
const hasSample = computed(() => !!w.link.sampleId);
// An offline session (signed in with no connection) has no token to upload with, even if the
// network has since returned -- the banner at the top is the way back to a real session.
const offlineSession = computed(() => authStore.state.offline);
const canUpload = computed(() => online.value && !offlineSession.value && hasSample.value);

const uploadDb = ref(canUpload.value);
const saveMat = ref(false);
const saveCsv = ref(false);
// Untick (not just disable) whenever upload stops being possible — a checked-but-disabled box still
// reads as "this will happen" and `save()` only tests uploadDb.
watch(canUpload, (v) => { if (!v) uploadDb.value = false; });

// finalize.py skips writing capture.mat for captures over its size limit (mat_written:false in the
// summary) — matches the check in workspace.ts's uploadCutToDatabase. Untick (not just disable) for
// the same reason as uploadDb above: a checked-but-disabled box still reads as "this will happen".
const matAvailable = computed(() => w.st.summary?.mat_written !== false);
watch(matAvailable, (v) => { if (!v) saveMat.value = false; });

// Whether the operator dragged a crop handle away from the auto-detected default (#7) — gates the
// "adjusted" note and its Reset button; save() sends an explicit override only in that case too
// (see workspace.ts's uploadCutToDatabase).
const cutWindowEdited = computed(() => {
	const c = w.finishedCache.value;
	if (!c) return false;
	return w.editCutStartSec.value !== c.csSec || w.editCutEndSec.value !== c.ceSec;
});
function resetCutWindow() {
	const c = w.finishedCache.value;
	if (!c) return;
	w.editCutStartSec.value = c.csSec;
	w.editCutEndSec.value = c.ceSec;
}

const stage = ref<'ask' | 'saving' | 'done' | 'discard-confirm'>('ask');
const errMsg = ref<string | null>(null);
const savedOpId = ref<string | null>(null);
const nothingSelected = computed(() => !uploadDb.value && !saveMat.value && !saveCsv.value);

// The dialog opens the instant Stop is pressed (workspace.ts) — st.state is still 'recording' for
// a brief moment (waiting on the backend ack), then 'finalizing' while the backend writes the
// full-resolution .mat/live_cache/summary in the background. Show a loading state through both so
// the user gets immediate feedback instead of a UI that looks live but has actually already
// stopped. Only once state is 'done' AND the finished trace has loaded do we show the save form.
// 'recording' only counts while the stop request is in flight: after it settles with the run still
// recording (the recorder refused or could not be reached) there is nothing to wait for.
const stopping = computed(() => w.st.state === 'recording' && w.busy.value);
const notStopped = computed(() => w.st.state === 'recording' && !w.busy.value);
const loading = computed(() => stopping.value || w.st.state === 'finalizing' || (w.st.state === 'done' && !w.finishedCache.value));
const failed = computed(() => w.st.state === 'error' && !w.finishedCache.value);
// #84: "failed to start" (nothing captured, nothing kept) is not "finalize failed" (raw still on
// disk) — the dialog used to claim the latter for both. The raw driver text sits behind Details.
const failure = computed(() => describeRecordingFailure(w.st.error, w.st.errorKind, w.st.nTotal));
function fixField() {
	const field = failure.value.field;
	w.dismissFailure(failure.value.rawKept);
	if (field === 'sample_rate') setTimeout(() => spotlight('sample-rate'), 0);
}

// Three-stage save/finalize progress, each timed independently, so a slow save reads as "which
// stage is taking long, and for how long" instead of one undifferentiated spinner. Backend timing
// for the equivalent stages (acquisition stop, finalize write, capture-file fetch) is also logged
// server-side (backend.log, next to storage_config.json) — the two should roughly agree; if they
// don't, the gap is somewhere else (network, Electron sidecar, etc).
type StageKey = 'stop' | 'finalize' | 'load';
const STAGES: { key: StageKey; label: string }[] = [
	{ key: 'stop', label: 'Stopping acquisition' },
	{ key: 'finalize', label: 'Writing capture files (.mat, live cache)' },
	{ key: 'load', label: 'Loading recorded trace' },
];
const stageState = reactive<Record<StageKey, { start: number | null; end: number | null }>>({
	stop: { start: null, end: null }, finalize: { start: null, end: null }, load: { start: null, end: null },
});
function mark(stage: StageKey, field: 'start' | 'end') {
	if (stageState[stage][field] == null) stageState[stage][field] = performance.now();
}
watch(() => w.st.state, (s) => {
	if (s === 'recording') mark('stop', 'start');
	if (s === 'finalizing') { mark('stop', 'start'); mark('stop', 'end'); mark('finalize', 'start'); }
	if (s === 'done' || s === 'error') {
		mark('stop', 'start'); mark('stop', 'end'); mark('finalize', 'start'); mark('finalize', 'end'); mark('load', 'start');
	}
}, { immediate: true });
watch(() => w.finishedCache.value, (c) => { if (c) mark('load', 'end'); });

// Ticks a reactive clock while any stage is in flight so elapsed-time readouts count up live
// instead of only updating when Vue happens to re-render for another reason.
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { tickTimer = setInterval(() => { tick.value++; }, 250); });
onBeforeUnmount(() => { if (tickTimer) clearInterval(tickTimer); });

function stageStatus(key: StageKey): 'pending' | 'active' | 'done' {
	const s = stageState[key];
	if (s.start == null) return 'pending';
	return s.end == null ? 'active' : 'done';
}
function stageElapsed(key: StageKey): number {
	void tick.value; // reactivity dependency — recompute on every tick while a stage is active
	const s = stageState[key];
	if (s.start == null) return 0;
	return ((s.end ?? performance.now()) - s.start) / 1000;
}

// loadFinished() already retries a few times internally; if state is 'done' and the trace still
// hasn't shown up after a while (a persistent failure, not just a blip), offer a manual retry
// link under the progress list rather than spinning forever with no way out.
const showManualRetry = ref(false);
let manualRetryTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => w.st.state === 'done' && !w.finishedCache.value, (stuck) => {
	if (manualRetryTimer) { clearTimeout(manualRetryTimer); manualRetryTimer = null; }
	showManualRetry.value = false;
	if (stuck) manualRetryTimer = setTimeout(() => { showManualRetry.value = true; }, 6000);
}, { immediate: true });
onBeforeUnmount(() => { if (manualRetryTimer) clearTimeout(manualRetryTimer); });

// float32 rows, matching the raw writer — see RAW_BYTES_PER_SAMPLE.
const estSizeMb = computed(() => (w.st.nTotal ? (w.st.nTotal * RAW_COLUMNS * RAW_BYTES_PER_SAMPLE) / 1e6 : 0));

function downloadUrl(href: string, filename: string) {
	const a = document.createElement('a');
	a.href = href; a.download = filename;
	document.body.appendChild(a); a.click(); a.remove();
}

function downloadMat() {
	const id = w.st.captureId;
	if (!id || !matAvailable.value) return;
	downloadUrl(w.client.matUrl(id), `${id}.mat`);
}

function downloadCsv() {
	const c = w.finishedCache.value;
	const id = w.st.captureId || 'capture';
	if (!c) return;
	const lines = ['t,Fx,Fy,Fz,rpm,revs'];
	for (let i = 0; i < c.t.length; i++) {
		lines.push(`${c.t[i]},${c.Fx[i]},${c.Fy[i]},${c.Fz[i]},${c.rpm[i]},${c.revs[i]}`);
	}
	const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
	downloadUrl(URL.createObjectURL(blob), `${id}.csv`);
}

async function confirmSave() {
	errMsg.value = null;
	stage.value = 'saving';
	try {
		// #190: keep the adjusted crop on the recorder (best effort, never throws). It runs alongside
		// the downloads and must have landed before the upload, which can fail.
		const cropSaved = w.saveCropLocally();
		if (saveMat.value) downloadMat();
		if (saveCsv.value) downloadCsv();
		await cropSaved;
		if (uploadDb.value) savedOpId.value = await w.uploadCutToDatabase();
		stage.value = 'done';
	} catch (e: any) {
		errMsg.value = e?.message || 'save failed';
		stage.value = 'ask';
	}
}

function askDiscard() { stage.value = 'discard-confirm'; }
function cancelDiscard() { stage.value = 'ask'; }
// Regression: this used to only close the dialog (w.saveOpen.value = false) without resetting the
// workspace, unlike startNew() below. The finished cut's full force/FFT/spectrogram buffers (and
// finishedCache) stayed live in `w.client` — the plots kept showing the just-discarded recording,
// and every plot-type switch kept recomputing against that stale, still-full-size data instead of
// an idle/empty one. w.newRun() (client.reset() + finishedCache = null, same as startNew()) is
// what actually clears it.
function confirmDiscard() {
	w.newRun(false); // nothing was kept: the retake is the same cut, so no sequence step
	stage.value = 'ask';
}

function goToPlot() {
	w.saveOpen.value = false;
	// Uploaded -> the real analysis page; not (yet) uploaded -> the local-files fallback view, which
	// works purely off the recorder backend and needs no database record at all.
	if (savedOpId.value) router.push({ name: 'plot', query: { operation: savedOpId.value } });
	else if (w.st.captureId) router.push({ name: 'plot-local', params: { captureId: w.st.captureId } });
}
function startNew() {
	w.saveOpen.value = false;
	w.newRun();
}
</script>

<template>
	<div class="scd-backdrop dialog-backdrop-in">
		<div ref="panel" class="scd-modal dialog-in" role="dialog" aria-modal="true" aria-labelledby="scd-title" tabindex="-1">
			<header class="scd-head">
				<span class="material-symbols-rounded">task_alt</span>
				<div class="scd-title">
					<b id="scd-title">{{ failed ? failure.title : 'Recording finished' }}</b>
					<span class="scd-sub">{{ w.meta.sample_name || 'Untitled cut' }} · {{ (w.st.summary?.duration_sec ?? w.st.tSec).toFixed(1) }}s</span>
				</div>
			</header>

			<template v-if="loading">
				<div class="scd-progress">
					<div v-for="s in STAGES" :key="s.key" class="scd-stage" :class="stageStatus(s.key)">
						<span class="scd-stage-icon material-symbols-rounded" :class="{ spin: stageStatus(s.key) === 'active' }">
							{{ stageStatus(s.key) === 'done' ? 'check_circle' : stageStatus(s.key) === 'active' ? 'progress_activity' : 'radio_button_unchecked' }}
						</span>
						<span class="scd-stage-label">{{ s.label }}</span>
						<span v-if="stageStatus(s.key) !== 'pending'" class="scd-stage-time">{{ stageElapsed(s.key).toFixed(1) }}s</span>
					</div>
					<span v-if="w.st.nTotal" class="scd-loading-sub">{{ w.st.nTotal.toLocaleString() }} samples · ~{{ formatMegabytes(estSizeMb) }}</span>
					<button v-if="showManualRetry" class="btn" @click="w.loadFinished()">Still loading — try again</button>
				</div>
			</template>

			<template v-else-if="notStopped">
				<div class="scd-confirm">
					<span class="material-symbols-rounded warn">error</span>
					<div class="scd-fail">
						<p>The recording is still running: it did not stop. Close this and press Stop again.</p>
						<p v-if="w.errMsg.value">{{ w.errMsg.value }}</p>
					</div>
				</div>
				<div class="scd-actions">
					<div class="scd-spacer"></div>
					<button class="btn primary" @click="w.saveOpen.value = false">Close</button>
				</div>
			</template>

			<template v-else-if="failed">
				<div class="scd-confirm">
					<span class="material-symbols-rounded warn">error</span>
					<div class="scd-fail">
						<p>{{ failure.summary }}</p>
						<details v-if="failure.details" class="scd-details">
							<summary>Details</summary>
							<pre>{{ failure.details }}</pre>
						</details>
					</div>
				</div>
				<div class="scd-actions">
					<div class="scd-spacer"></div>
					<button v-if="failure.field" class="btn" @click="fixField">Show me the setting</button>
					<button class="btn primary" @click="w.dismissFailure(failure.rawKept)">Close</button>
				</div>
			</template>

			<template v-else>
			<p v-if="w.finishedCache.value" class="scd-plot-hint">Drag the shaded window's edges to adjust the detected cut start/end before saving.</p>
			<div class="scd-plot">
				<FinishedForcePlot v-if="w.finishedCache.value" :cache="w.finishedCache.value"
					crop-editable
					:crop-start-sec="w.editCutStartSec.value" :crop-end-sec="w.editCutEndSec.value"
					@update:crop-start-sec="w.editCutStartSec.value = $event"
					@update:crop-end-sec="w.editCutEndSec.value = $event" />
				<div v-else class="scd-loading">
					<span class="material-symbols-rounded spin">progress_activity</span>
					<span>Loading recorded trace…</span>
				</div>
			</div>
			<div v-if="w.finishedCache.value && cutWindowEdited" class="scd-crop-note">
				<span class="material-symbols-rounded">tune</span>
				<span>Cut window adjusted: {{ w.editCutStartSec.value?.toFixed(2) }}s – {{ w.editCutEndSec.value?.toFixed(2) }}s
					(auto-detected: {{ w.finishedCache.value.csSec.toFixed(2) }}s – {{ w.finishedCache.value.ceSec.toFixed(2) }}s)</span>
				<button class="scd-crop-reset" type="button" @click="resetCutWindow">Reset</button>
			</div>

			<template v-if="stage === 'ask' || stage === 'saving'">
				<div class="scd-opts">
					<label class="scd-opt">
						<input type="checkbox" v-model="uploadDb" :disabled="!canUpload || stage === 'saving'" />
						<div>
							<span>Upload to database</span>
							<small v-if="!online">offline — the capture stays on this PC; upload it later from Settings → Local Captures (recorded under your name)</small>
							<small v-else-if="offlineSession">signed in offline — use "Sign in to sync" at the top, then upload from Settings → Local Captures</small>
							<small v-else-if="!hasSample">pick a Sample in Metadata to enable database logging</small>
							<small v-else>logs this run and links the capture into machining_force_analysis</small>
						</div>
					</label>
					<label class="scd-opt">
						<input type="checkbox" v-model="saveMat" :disabled="stage === 'saving' || !matAvailable" />
						<div>
							<span>Save a local copy (.mat)</span>
							<small v-if="!matAvailable">exceeds size limit — not written for this capture</small>
						</div>
					</label>
					<label class="scd-opt">
						<input type="checkbox" v-model="saveCsv" :disabled="stage === 'saving'" />
						<span>Save a local copy (.csv)</span>
					</label>
				</div>

				<p v-if="errMsg" class="scd-err">
					{{ errMsg }}
					<br>The recording itself is safe on disk regardless — you can still view it or start a new run below.
				</p>

				<div class="scd-actions">
					<button class="btn danger quiet" :disabled="stage === 'saving'" @click="askDiscard">Don't save</button>
					<!-- Not gated on the save/upload choice above — the raw capture, .mat and live_cache are
						 already finalized on disk the moment this stage is reachable (finalize() writes them
						 unconditionally; the checkboxes above only add a DB record and/or a Downloads copy),
						 so jumping straight to the plot view here is always safe. -->
					<button class="btn" :disabled="stage === 'saving'" @click="goToPlot">Open in Plot</button>
					<button v-if="errMsg" class="btn" :disabled="stage === 'saving'" @click="startNew">Start new run</button>
					<div class="scd-spacer"></div>
					<button class="btn primary" data-save-primary :disabled="nothingSelected || stage === 'saving'" @click="confirmSave">
						{{ stage === 'saving' ? 'Saving…' : errMsg ? 'Retry' : 'Save' }}
					</button>
				</div>
			</template>

			<template v-else-if="stage === 'discard-confirm'">
				<div class="scd-confirm">
					<span class="material-symbols-rounded warn">warning</span>
					<p>Discard this recording without saving? It will <b>not</b> be uploaded or logged — the raw capture stays on disk locally, but nothing will be recorded in the database and no local copy will be exported.</p>
				</div>
				<div class="scd-actions">
					<button class="btn" @click="cancelDiscard">Cancel</button>
					<div class="scd-spacer"></div>
					<button class="btn danger" @click="confirmDiscard">Yes, discard</button>
				</div>
			</template>

			<template v-else-if="stage === 'done'">
				<div class="scd-confirm ok">
					<span class="material-symbols-rounded ok">check_circle</span>
					<p>Saved. {{ savedOpId ? 'Logged to the database.' : 'Saved locally — you can still view and plot it, and upload it to the database later.' }}</p>
				</div>
				<div class="scd-actions">
					<button class="btn" @click="startNew">Start new run</button>
					<div class="scd-spacer"></div>
					<button class="btn primary" data-save-primary @click="goToPlot">
						Open in Plot
					</button>
				</div>
			</template>
			</template>
		</div>
	</div>
</template>

<style scoped>
.scd-backdrop { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); padding: calc(24px + var(--offline-banner-h, 0px)) 24px 24px; }
.scd-modal { width: min(880px, 100%); max-height: 92vh; overflow: auto; display: flex; flex-direction: column; gap: 14px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
.scd-head { display: flex; align-items: center; gap: 12px; }
.scd-head > .material-symbols-rounded { font-size: var(--icon-xl); color: var(--ok); }
.scd-title { display: flex; flex-direction: column; }
.scd-title b { font-size: var(--fs-lg); }
.scd-sub { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.scd-plot-hint { margin: 0 0 6px; font-size: var(--fs-xs); color: var(--text-dim); }
.scd-plot { height: 280px; }
.scd-crop-note { display: flex; align-items: center; gap: 7px; margin-top: 8px; padding: 7px 10px; font-size: var(--fs-sm); color: var(--text-dim);
	background: color-mix(in srgb, var(--ok) 8%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 25%, transparent); border-radius: 8px; }
.scd-crop-note .material-symbols-rounded { font-size: var(--icon-sm); color: var(--ok); flex-shrink: 0; }
.scd-crop-note span:nth-child(2) { flex: 1; font-variant-numeric: tabular-nums; }
.scd-crop-reset { flex-shrink: 0; padding: 3px 9px; font-size: var(--fs-xs); font-weight: 700; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.scd-crop-reset:hover { background: var(--surface); }
.scd-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 200px; color: var(--text); }
.scd-loading b { font-size: var(--fs-lg); font-weight: 600; }
.scd-loading-sub { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; text-align: center; margin-top: 4px; }
.scd-loading .spin { font-size: var(--icon-2xl); color: var(--accent); }
.scd-progress { display: flex; flex-direction: column; gap: 4px; justify-content: center; min-height: 200px; padding: 8px 4px; }
.scd-stage { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; font-size: var(--fs-md); color: var(--text-dim); }
.scd-stage.active { color: var(--text); background: var(--surface); }
.scd-stage.done { color: var(--text-dim); }
.scd-stage-icon { font-size: var(--icon-md); flex-shrink: 0; }
.scd-stage.done .scd-stage-icon { color: var(--ok); }
.scd-stage.active .scd-stage-icon { color: var(--accent); }
.scd-stage-label { flex: 1; }
.scd-stage-time { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--text-dim); }
.scd-opts { display: flex; flex-direction: column; gap: 8px; }
.scd-opt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; cursor: pointer; }
.scd-opt input { margin-top: 2px; }
.scd-opt div, .scd-opt span { display: flex; flex-direction: column; font-size: var(--fs-md); color: var(--text); }
.scd-opt small { font-size: var(--fs-xs); color: var(--text-dim); font-weight: 400; }
.scd-err { font-size: var(--fs-sm); color: var(--danger); background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 8px 10px; }
.scd-actions { display: flex; align-items: center; gap: 10px; }
.scd-spacer { flex: 1; }
.scd-confirm { display: flex; align-items: flex-start; gap: 10px; padding: 12px; background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 9px; font-size: var(--fs-md); }
.scd-confirm.ok { background: color-mix(in srgb, var(--ok) 8%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.scd-confirm .material-symbols-rounded.warn { color: var(--warn); font-size: var(--icon-xl); }
.scd-confirm .material-symbols-rounded.ok { color: var(--ok); font-size: var(--icon-xl); }
.scd-confirm p { margin: 0; color: var(--text); }
.scd-fail { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.scd-details { font-size: var(--fs-xs); color: var(--text-dim); }
.scd-details summary { cursor: pointer; }
.scd-details pre { margin: 4px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
</style>
