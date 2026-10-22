<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
	CONFORM_STATUS, ConformLogError, ConformLogHiddenError, LOG_LOAD_FAILED, LOG_NOT_VISIBLE, labelWindows, loadLogTrace, plainReason, recomputeRun,
	resolveWindowEntry, setRunWindow, stepsToCsv, ukInputValue, unlinkLog, windowLine as windowItem, type LogWindow,
	type ConformRunBundle,
} from '@d1/fast-plotting';
import { DataTable, FactList, LoadState, Section, StatusBadge, analysisLink, useExplorerHost, type SectionState } from '@d1/ui';
import { conformApi } from '../conformApi';
import ConformTrace from '../map/ConformTrace.vue';
import ConformTraceKey from '../map/ConformTraceKey.vue';
import { conformThumb, type ConformThumb } from '../map/model/conformThumb';
import ConformLogSource from './ConformLogSource.vue';
import {
	STEP_COLUMNS, energyRows, logSpanText, missingText, needsLog, needsRecompute, stepCells, summaryRows, totalsRows, windowText,
} from './conformRows';

// The "Conform run" section of the Operation page: the run's status, its run window (editable, in UK clock time), the summary and energy
// worked out over that window, the steps table (copyable as CSV for a spreadsheet), the whole-log totals, the other runs' windows on the
// same log, and where the log comes from (upload, use one already uploaded, unlink, replace). A reader may see the run and not the log: the
// summary and steps are the run's own and still show, the trace and the log's totals say the log is not visible. The section stays mounted
// while the page reads the run again, so the window fields keep their focus. Words: Conform run, Conform log, Run window, Step (CONTEXT.md).
const props = withDefaults(
	defineProps<{
		operationId: string;
		equipmentId?: string | null;
		operationDate?: string | null;
		/** `planned` runs never get an operation date written from the log. */
		workState?: string | null;
		state: SectionState<ConformRunBundle | null>;
		/** The reader may change the run (upload, window, recompute, unlink); the server still decides. */
		canEdit?: boolean;
	}>(),
	{ equipmentId: null, operationDate: null, workState: null, canEdit: true },
);
const emit = defineEmits<{ changed: [] }>();

const host = useExplorerHost();
const api = () => conformApi(host.api);

const run = computed(() => props.state.data?.run ?? null);
const log = computed(() => props.state.data?.log ?? null);
const logHidden = computed(() => !!props.state.data?.logHidden);
const summary = computed(() => run.value?.summary ?? null);
const steps = computed(() => run.value?.steps ?? []);
const link = computed(() => (run.value?.log_id ? analysisLink(props.operationId, 'conform') : null));
const noLog = computed(() => needsLog(run.value));
const recompute = computed(() => needsRecompute(run.value));
// The page's first read has not answered yet (a reload keeps the data and the section on screen).
const firstLoad = computed(() => props.state.loading && !props.state.data);

// ---- the run window, as UK clock times
const startLocal = ref('');
const endLocal = ref('');
watch(
	() => [run.value?.window_start, run.value?.window_end],
	() => {
		startLocal.value = ukInputValue(run.value?.window_start);
		endLocal.value = ukInputValue(run.value?.window_end);
	},
	{ immediate: true },
);
const dirty = computed(() => startLocal.value !== ukInputValue(run.value?.window_start) || endLocal.value !== ukInputValue(run.value?.window_end));
const bounds = computed(() => ({ min: ukInputValue(log.value?.log_start), max: ukInputValue(log.value?.log_end) }));

const busy = ref<'window' | 'recompute' | 'unlink' | null>(null);
const error = ref('');
const warning = ref('');
const copied = ref(false);
const messageOf = (e: unknown): string => (e instanceof ConformLogError ? e.message : plainReason(e, 'Could not save the change. Try again.'));

async function act(kind: 'window' | 'recompute' | 'unlink', fn: () => Promise<unknown>, note = ''): Promise<boolean> {
	if (busy.value) return false;
	busy.value = kind;
	error.value = '';
	warning.value = '';
	try {
		await fn();
		warning.value = note;
		emit('changed');
		return true;
	} catch (e) {
		error.value = messageOf(e);
		return false;
	} finally {
		busy.value = null;
	}
}

// A field left alone keeps its stored instant (no truncation to the second); an edited one is clamped to the log, with a note.
function saveWindow(): Promise<unknown> {
	if (!dirty.value || busy.value || !log.value) return Promise.resolve();
	const r = resolveWindowEntry(
		{ startLocal: startLocal.value, endLocal: endLocal.value },
		{ start: run.value?.window_start ?? null, end: run.value?.window_end ?? null },
		log.value,
	);
	if (!r.ok) {
		error.value = r.error;
		return Promise.resolve();
	}
	return act('window', () => setRunWindow(api(), props.operationId, new Date(r.startMs).toISOString(), new Date(r.endMs).toISOString()), r.notes.join(' '));
}
const doRecompute = (): Promise<boolean> => act('recompute', () => recomputeRun(api(), props.operationId));

// ---- unlink and replace: one inline confirm. It opens with focus on Cancel (the safe choice), Escape or Cancel closes it and gives the
// focus back to the button that opened it, and what it says is announced (aria-live).
const confirming = ref<'unlink' | 'replace' | null>(null);
const replacing = ref(false);
const cancelBtn = ref<HTMLButtonElement | null>(null);
const unlinkBtn = ref<HTMLButtonElement | null>(null);
const replaceBtn = ref<HTMLButtonElement | null>(null);
const CONFIRM_TEXT = {
	unlink: { label: 'Unlink the log', sentence: 'Unlink this log from the run? This clears the run window, summary and steps. A log no other run uses is deleted.', go: 'Unlink', button: 'Unlink the log' },
	replace: { label: 'Replace the log', sentence: 'Replace the log? It is unlinked first, which clears the run window, summary and steps. A log no other run uses is deleted.', go: 'Unlink and replace', button: 'Unlink and replace the log' },
} as const;
async function ask(mode: 'unlink' | 'replace'): Promise<void> {
	if (busy.value) return;
	confirming.value = mode;
	await nextTick();
	cancelBtn.value?.focus();
}
function cancelConfirm(): void {
	const mode = confirming.value;
	confirming.value = null;
	void nextTick(() => (mode === 'replace' ? replaceBtn : unlinkBtn).value?.focus());
}
async function doUnlink(): Promise<void> {
	const wasReplace = confirming.value === 'replace';
	confirming.value = null;
	if (await act('unlink', () => unlinkLog(api(), props.operationId))) replacing.value = wasReplace;
}

async function copyCsv(): Promise<void> {
	try {
		await navigator.clipboard.writeText(stepsToCsv(steps.value));
		copied.value = true;
		setTimeout(() => (copied.value = false), 2000);
	} catch {
		error.value = 'The steps could not be copied. Select them in the table instead.';
	}
}

function onSourceChanged(dateWarning: string): void {
	replacing.value = false;
	warning.value = dateWarning;
	emit('changed');
}

// ---- the trace of the window (reads the log's CSV, once per log; no trace is no error, but a forbidden file or a failed download says so)
const thumb = ref<ConformThumb | null>(null);
const traceNote = ref('');
let traceFor = 0;
watch(
	() => [log.value?.log_id, run.value?.window_start, run.value?.window_end],
	async () => {
		const mine = ++traceFor;
		thumb.value = null;
		traceNote.value = '';
		const l = log.value;
		const r = run.value;
		if (!l || !r?.window_start || !r.window_end) return;
		try {
			const t = conformThumb(await loadLogTrace(api(), l), l, r);
			if (mine === traceFor) thumb.value = t;
		} catch (e) {
			if (mine === traceFor) traceNote.value = e instanceof ConformLogHiddenError ? LOG_NOT_VISIBLE : LOG_LOAD_FAILED;   // the summary and steps stand without it
		}
	},
	{ immediate: true },
);

// ---- the other runs' windows on this log (the log row carries them; a run the reader cannot see is "Other run")
const windows = ref<LogWindow[]>([]);
let windowsFor = 0;
watch(
	() => JSON.stringify(log.value?.run_windows ?? []),
	async () => {
		const mine = ++windowsFor;
		const l = log.value;
		if (!l?.run_windows.length) { windows.value = []; return; }
		const labelled = await labelWindows(api(), l.run_windows);
		if (mine === windowsFor) windows.value = labelled;
	},
	{ immediate: true },
);
const otherWindows = computed(() => windows.value.filter((w) => w.operation_id !== props.operationId));

const windowLine = computed(() => windowText(run.value));
const logLine = computed(() => (log.value ? `${log.value.source_filename} · ${logSpanText(log.value.log_start, log.value.log_end)}` : ''));
// The badge: a run with no log linked is "No log" whatever its stored status says.
const statusKey = computed(() => (noLog.value ? 'no_log' : (run.value?.status ?? 'no_log')));
const statusHint = computed(() => CONFORM_STATUS[statusKey.value as keyof typeof CONFORM_STATUS]?.hint);
</script>

<template>
	<Section id="conform-run" title="Conform run">
		<template v-if="link" #actions>
			<v-button x-small secondary :to="link.to"><v-icon name="show_chart" x-small left />Open in Conform plotter</v-button>
		</template>
		<LoadState :loading="firstLoad" :error="state.data ? '' : state.error">
			<div class="stack">
				<p v-if="state.loading" class="d1-note" role="status">Updating…</p>
				<p v-if="state.error && state.data" class="d1-note bad" role="alert">{{ state.error }}</p>
				<div class="status"><StatusBadge kind="conform" :value="statusKey" :title="statusHint" /></div>
				<p v-if="run?.status === 'error' && run.error_message" class="d1-note bad">{{ run.error_message }}</p>
				<p v-if="warning" class="d1-note warn" role="status">{{ warning }}</p>
				<p v-if="error" class="d1-note bad" role="alert">{{ error }}</p>

				<ConformLogSource
					v-if="noLog && canEdit" :operation-id="operationId" :equipment-id="equipmentId" :operation-date="operationDate" :work-state="workState"
					:open-picker="replacing" @changed="onSourceChanged"
				/>
				<p v-else-if="noLog" class="d1-note">No Conform log has been uploaded for this run.</p>

				<template v-else>
					<p v-if="logHidden" class="d1-note">Conform log not visible to you</p>
					<p v-else-if="logLine" class="d1-note">Conform log: {{ logLine }}</p>

					<div v-if="canEdit || windowLine" class="window">
						<template v-if="canEdit && !logHidden">
							<label>Run window start <input v-model="startLocal" class="d1-input" type="datetime-local" step="1" :min="bounds.min" :max="bounds.max" aria-label="Run window start (UK time)" /></label>
							<label>end <input v-model="endLocal" class="d1-input" type="datetime-local" step="1" :min="bounds.min" :max="bounds.max" aria-label="Run window end (UK time)" /></label>
							<span class="d1-note">UK time</span>
							<button type="button" class="d1-btn pri" :aria-disabled="!dirty || !!busy" @click="saveWindow">{{ busy === 'window' ? 'Saving…' : 'Set run window' }}</button>
						</template>
						<span v-else-if="windowLine" class="win-text">Run window {{ windowLine }}</span>
						<button v-if="recompute && canEdit && !logHidden" type="button" class="d1-btn" :aria-disabled="!!busy" @click="!busy && doRecompute()">{{ busy === 'recompute' ? 'Recomputing…' : 'Recompute' }}</button>
						<template v-if="canEdit">
							<button ref="unlinkBtn" type="button" class="d1-btn" :aria-disabled="!!busy" title="Take this log off the run and clear its window, summary and steps" @click="ask('unlink')">Unlink log</button>
							<button ref="replaceBtn" type="button" class="d1-btn" :aria-disabled="!!busy" title="Unlink this log, then upload another or pick one" @click="ask('replace')">Replace log</button>
						</template>
					</div>
					<div class="live" aria-live="polite">
						<div v-if="confirming" class="confirm" role="group" :aria-label="CONFIRM_TEXT[confirming].label" @keydown.esc="cancelConfirm">
							<span>{{ CONFIRM_TEXT[confirming].sentence }}</span>
							<span class="row">
								<button type="button" class="d1-btn danger" :disabled="!!busy" :aria-label="CONFIRM_TEXT[confirming].button" @click="doUnlink">{{ CONFIRM_TEXT[confirming].go }}</button>
								<button ref="cancelBtn" type="button" class="d1-btn" @click="cancelConfirm">Cancel</button>
							</span>
						</div>
					</div>

					<div v-if="otherWindows.length" class="others">
						<h3>Other runs on this log</h3>
						<ul><li v-for="w in otherWindows" :key="w.operation_id + w.start">{{ windowItem(w) }}</li></ul>
					</div>

					<div v-if="thumb" class="trace-card"><ConformTrace :thumb="thumb" :height="72" /><ConformTraceKey :thumb="thumb" /></div>
					<p v-else-if="traceNote && !logHidden" class="d1-note">{{ traceNote }}</p>

					<div v-if="summary" class="cols">
						<div>
							<h3>Summary</h3>
							<FactList :facts="summaryRows(summary)" columns="auto" />
						</div>
						<div>
							<h3>Energy</h3>
							<FactList :facts="energyRows(summary.energy_kwh, summary.avg_demand_kw)" columns="auto" />
							<p v-if="missingText(summary.missing)" class="d1-note gap">{{ missingText(summary.missing) }}</p>
						</div>
					</div>
					<p v-else-if="run?.status === 'no_window'" class="d1-note">{{ canEdit && !logHidden ? 'Set the run window to see its summary, energy and steps.' : 'No run window is set.' }}</p>

					<template v-if="summary">
						<div class="steps-head">
							<h3>Steps <span class="count">{{ steps.length }}</span></h3>
							<button v-if="steps.length" type="button" class="d1-btn" @click="copyCsv">{{ copied ? 'Copied' : 'Copy as CSV' }}</button>
						</div>
						<p v-if="!steps.length" class="d1-note">No step of a minute or more at one IPS setpoint and wheel speed in this window.</p>
						<DataTable v-else figures>
							<thead><tr><th v-for="c in STEP_COLUMNS" :key="c">{{ c }}</th></tr></thead>
							<tbody>
								<tr v-for="(s, i) in steps" :key="i" class="step"><td v-for="(cell, k) in stepCells(s)" :key="k">{{ cell }}</td></tr>
							</tbody>
						</DataTable>
					</template>

					<div v-if="log">
						<h3>Whole log</h3>
						<FactList :facts="totalsRows(log.totals)" columns="auto" />
						<p v-if="missingText(log.totals.missing)" class="d1-note gap">{{ missingText(log.totals.missing) }}</p>
					</div>
				</template>
			</div>
		</LoadState>
	</Section>
</template>

<style scoped>
.stack { display: grid; gap: 10px; }
.status { display: flex; align-items: center; gap: 8px; }
.gap { margin-top: 6px; }
.d1-note { overflow-wrap: anywhere; }
.window { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: var(--fs-sm, 12px); }
.window label { display: inline-flex; align-items: center; gap: 6px; }
.win-text { font-variant-numeric: tabular-nums; }
.confirm { display: grid; gap: 8px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); font-size: var(--fs-sm, 12px); }
/* The live region is always there (so what the confirm says is announced); empty, it takes no gap. */
.live:empty { margin-top: -10px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.others h3 { margin-top: 0; }
.others ul { margin: 0; padding-left: 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.trace-card { padding: 6px 8px; border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 28px; }
h3 { margin: 0 0 4px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); text-transform: none; }
.count { font-weight: 400; margin-left: 4px; }
.steps-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.steps-head h3 { margin: 0; }
td { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
