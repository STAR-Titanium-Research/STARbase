<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ConformLogError, loadLogTrace, recomputeRun, setRunWindow, stepsToCsv, formatUkDateTime } from '@d1/fast-plotting';
import { DataTable, LoadState, Section, analysisLink, errorText, ukInputValue, ukLocalToMs, useExplorerHost, type SectionState } from '@d1/ui';
import { conformApi } from '../conformApi';
import ConformTrace from '../map/ConformTrace.vue';
import { conformThumb, type ConformThumb } from '../map/model/conformThumb';
import ConformLogSource from './ConformLogSource.vue';
import {
	STEP_COLUMNS, energyRows, missingText, needsLog, needsRecompute, statusText, stepCells, summaryRows, totalsRows, windowText,
} from './conformRows';
import type { ConformRunData } from './useOperationData';

// The "Conform run" section of the Operation page: the run's status, its run window (editable, in UK clock time), the summary and energy
// worked out over that window, the steps table (copyable as CSV for a spreadsheet), the whole-log totals, and where the log comes from.
// A reader may see the run and not the log: the summary and steps are the run's own and still show, the trace and the log's totals say the
// log is not visible. Words: Conform run, Conform log, Run window, Step (CONTEXT.md).
const props = withDefaults(
	defineProps<{
		operationId: string;
		equipmentId?: string | null;
		operationDate?: string | null;
		state: SectionState<ConformRunData | null>;
		/** The reader may change the run (upload, window, recompute); the server still decides. */
		canEdit?: boolean;
	}>(),
	{ equipmentId: null, operationDate: null, canEdit: true },
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
const recompute = computed(() => needsRecompute(run.value, log.value));

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

const busy = ref<'window' | 'recompute' | null>(null);
const error = ref('');
const warning = ref('');
const copied = ref(false);
const messageOf = (e: unknown): string => (e instanceof ConformLogError ? e.message : errorText(e));

async function act(kind: 'window' | 'recompute', fn: () => Promise<unknown>): Promise<void> {
	if (busy.value) return;
	busy.value = kind;
	error.value = '';
	warning.value = '';
	try {
		await fn();
		emit('changed');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
	}
}

function saveWindow(): Promise<void> {
	const start = ukLocalToMs(startLocal.value);
	const end = ukLocalToMs(endLocal.value);
	if (Number.isNaN(start) || Number.isNaN(end)) {
		error.value = 'Enter the start and end of the run window as UK clock times.';
		return Promise.resolve();
	}
	return act('window', () => setRunWindow(api(), props.operationId, new Date(start).toISOString(), new Date(end).toISOString()));
}
const doRecompute = (): Promise<void> => act('recompute', () => recomputeRun(api(), props.operationId));

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
	warning.value = dateWarning;
	emit('changed');
}

// ---- the trace of the window (reads the log's CSV, once per log; no trace is no error)
const thumb = ref<ConformThumb | null>(null);
let traceFor = 0;
watch(
	() => [log.value?.log_id, run.value?.window_start, run.value?.window_end],
	async () => {
		const mine = ++traceFor;
		thumb.value = null;
		const l = log.value;
		const r = run.value;
		if (!l || !r?.window_start || !r.window_end) return;
		try {
			const t = conformThumb(await loadLogTrace(api(), l), l, r);
			if (mine === traceFor) thumb.value = t;
		} catch {
			/* the summary and steps stand without it */
		}
	},
	{ immediate: true },
);

const windowLine = computed(() => windowText(run.value));
const logLine = computed(() => (log.value ? `${log.value.source_filename} · ${formatUkDateTime(log.value.log_start)} to ${formatUkDateTime(log.value.log_end)}` : ''));
</script>

<template>
	<Section id="conform-run" title="Conform run">
		<template v-if="link" #actions>
			<v-button x-small secondary :to="link.to"><v-icon name="show_chart" x-small left />Open in Conform plotter</v-button>
		</template>
		<LoadState :loading="state.loading" :error="state.error">
			<p class="status" :class="run?.status ?? 'no_log'">{{ statusText(run) }}</p>
			<p v-if="run?.status === 'error' && run.error_message" class="err">{{ run.error_message }}</p>
			<p v-if="warning" class="d1-note warn" role="status">{{ warning }}</p>
			<p v-if="error" class="err" role="alert">{{ error }}</p>

			<ConformLogSource v-if="noLog && canEdit" :operation-id="operationId" :equipment-id="equipmentId" :operation-date="operationDate" @changed="onSourceChanged" />
			<p v-else-if="noLog" class="dim">No Conform log has been uploaded for this run.</p>

			<template v-else>
				<p v-if="logHidden" class="d1-note hidden">Conform log not visible to you</p>
				<p v-else-if="logLine" class="dim log-line">Conform log: {{ logLine }}</p>

				<div class="window">
					<template v-if="canEdit && !logHidden">
						<label>Run window start <input v-model="startLocal" type="datetime-local" step="1" :min="bounds.min" :max="bounds.max" aria-label="Run window start (UK time)" /></label>
						<label>end <input v-model="endLocal" type="datetime-local" step="1" :min="bounds.min" :max="bounds.max" aria-label="Run window end (UK time)" /></label>
						<span class="dim">UK time</span>
						<button type="button" class="btn primary" :disabled="!dirty || !!busy" @click="saveWindow">{{ busy === 'window' ? 'Saving…' : 'Set run window' }}</button>
					</template>
					<span v-else-if="windowLine" class="win-text">Run window {{ windowLine }}</span>
					<button v-if="recompute && canEdit && !logHidden" type="button" class="btn" :disabled="!!busy" @click="doRecompute">{{ busy === 'recompute' ? 'Recomputing…' : 'Recompute' }}</button>
				</div>

				<div v-if="thumb" class="trace"><ConformTrace :thumb="thumb" :height="72" /></div>

				<template v-if="summary">
					<div class="cols">
						<div>
							<h3>Summary</h3>
							<dl><template v-for="r in summaryRows(summary)" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></template></dl>
						</div>
						<div>
							<h3>Energy</h3>
							<dl><template v-for="r in energyRows(summary.energy_kwh, summary.avg_demand_kw)" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></template></dl>
							<p v-if="missingText(summary.missing)" class="dim">{{ missingText(summary.missing) }}</p>
						</div>
					</div>
				</template>
				<p v-else-if="run?.status === 'no_window'" class="dim">Set the run window to see its summary, energy and steps.</p>

				<template v-if="summary">
					<div class="steps-head">
						<h3>Steps <span class="count">{{ steps.length }}</span></h3>
						<button v-if="steps.length" type="button" class="btn" @click="copyCsv">{{ copied ? 'Copied' : 'Copy as CSV' }}</button>
					</div>
					<p v-if="!steps.length" class="dim">No step of a minute or more at one IPS setpoint and wheel speed in this window.</p>
					<DataTable v-else>
						<thead><tr><th v-for="c in STEP_COLUMNS" :key="c">{{ c }}</th></tr></thead>
						<tbody>
							<tr v-for="(s, i) in steps" :key="i" class="step"><td v-for="(cell, k) in stepCells(s)" :key="k" :class="{ mono: k === 0 }">{{ cell }}</td></tr>
						</tbody>
					</DataTable>
				</template>

				<template v-if="log">
					<h3>Whole log</h3>
					<dl><template v-for="r in totalsRows(log.totals)" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></template></dl>
					<p v-if="missingText(log.totals.missing)" class="dim">{{ missingText(log.totals.missing) }}</p>
				</template>
			</template>
		</LoadState>
	</Section>
</template>

<style scoped>
.status { margin: 0 0 6px; font-weight: 600; font-size: var(--fs-md); }
.status.no_window { color: var(--d1-warn); }
.status.error { color: var(--d1-bad); }
.dim { color: var(--d1-dim); font-size: var(--fs-sm); margin: 0 0 6px; }
.err { margin: 0 0 6px; font-size: var(--fs-sm); color: var(--d1-bad); overflow-wrap: anywhere; }
.hidden { margin: 0 0 8px; }
.warn { color: var(--d1-warn); }
.window { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 8px 0; font-size: var(--fs-sm); }
.window label { display: inline-flex; align-items: center; gap: 6px; }
.window input { min-height: 28px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit; font: inherit; padding: 0 6px; }
.win-text { font-variant-numeric: tabular-nums; }
.trace { margin: 4px 0 10px; padding: 6px 8px; border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 28px; }
h3 { margin: 10px 0 4px; font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); text-transform: none; }
.count { font-weight: 400; margin-left: 4px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: var(--fs-md); }
dt { color: var(--d1-dim); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
.steps-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
td { font-variant-numeric: tabular-nums; white-space: nowrap; }
.btn {
	display: inline-flex; align-items: center; box-sizing: border-box; min-height: 28px; padding: 0 12px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); color: var(--d1-accent, var(--theme--primary));
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: transparent; color: var(--d1-on-accent, #fff); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
