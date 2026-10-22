<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import {
	ConformLogError, candidateLabel, candidatesEmptyText, labelWindows, linkExistingLog, listCandidateLogs, uploadConformLog, windowLine, wholeLogNote,
	type CandidateLog, type LogWindow,
} from '@d1/fast-plotting';
import { errorText, useExplorerHost } from '@d1/ui';
import { conformApi } from '../conformApi';

// Where a Conform run's log comes from, for a run that has none: upload the machine's CSV (read as bytes and processed here in the
// browser, the normalised file stored once) or use a log already uploaded (for another run, or for this one before it was unlinked): its
// run window starts empty. A file that is already uploaded is not uploaded again: the person is offered that log. Whatever the helper
// refuses is shown as it says it, e.g. a malformed file. With no run date the list is of logs around today. Both ways of choosing a log
// show the run windows already on it, and the note when one run's window fills the whole log, before the person confirms.
const props = defineProps<{
	operationId: string;
	equipmentId: string | null;
	operationDate: string | null;
	/** `planned` runs never get an operation date written from the log. */
	workState?: string | null;
	/** Open the "already uploaded" list at once (after "Replace log"). */
	openPicker?: boolean;
}>();
const emit = defineEmits<{ changed: [dateWarning: string] }>();

const host = useExplorerHost();
const api = () => conformApi(host.api);

const busy = ref<'upload' | 'link' | 'list' | null>(null);
const error = ref('');
const picking = ref(false);
const candidates = ref<CandidateLog[] | null>(null);
const chosen = ref('');
const duplicate = ref<{ id: string; label: string; windows: LogWindow[]; note: string | null } | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

const messageOf = (e: unknown): string => (e instanceof ConformLogError ? e.message : errorText(e));
const current = computed(() => candidates.value?.find((l) => l.log_id === chosen.value) ?? null);

async function onFile(ev: Event): Promise<void> {
	const input = ev.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file || busy.value) return;
	busy.value = 'upload';
	error.value = '';
	duplicate.value = null;
	try {
		const out = await uploadConformLog(
			api(),
			{ operation_id: props.operationId, equipment_id: props.equipmentId, operation_date: props.operationDate, work_state: props.workState ?? null },
			{ name: file.name, bytes: await file.arrayBuffer() },
		);
		if ('existing' in out) {
			// The windows of the log already uploaded: carried by the result (`existingWindows`), else labelled here from the log row.
			const carried = (out as { existingWindows?: LogWindow[] }).existingWindows;
			const windows = carried ?? (await labelWindows(api(), out.existing.run_windows));
			duplicate.value = { id: out.existing.log_id, label: candidateLabel(out.existing), windows, note: wholeLogNote(out.existing, windows) };
		} else emit('changed', out.dateWarning ?? '');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
		input.value = '';
	}
	if (duplicate.value) {   // the prompt opens with focus on Cancel, once the buttons are enabled again
		await nextTick();
		cancelBtn.value?.focus();
	}
}

async function showPicker(): Promise<void> {
	if (busy.value) return;
	picking.value = true;
	busy.value = 'list';
	error.value = '';
	try {
		candidates.value = await listCandidateLogs(api(), props.equipmentId, props.operationDate);
		chosen.value = candidates.value[0]?.log_id ?? '';
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
	}
}

async function link(id: string): Promise<void> {
	if (!id || busy.value) return;
	busy.value = 'link';
	error.value = '';
	try {
		await linkExistingLog(api(), props.operationId, id);
		duplicate.value = null;
		emit('changed', '');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
	}
}

function cancelDuplicate(): void {
	duplicate.value = null;
	void nextTick(() => uploadInput.value?.focus());
}

onMounted(() => { if (props.openPicker) void showPicker(); });
</script>

<template>
	<div class="source">
		<p class="lead">This run has no Conform log yet. Upload the machine's CSV, or use a log already uploaded.</p>
		<div class="row">
			<label class="up">
				<span class="d1-btn" :aria-disabled="busy ? 'true' : undefined">{{ busy === 'upload' ? 'Reading and uploading…' : 'Upload a log' }}</span>
				<input ref="uploadInput" type="file" accept=".csv,text/csv" class="file" :disabled="!!busy" aria-label="Upload a Conform log (CSV)" @change="onFile" />
			</label>
			<button v-if="!picking" type="button" class="d1-btn" :disabled="!!busy" @click="showPicker">Use a log already uploaded</button>
		</div>
		<div aria-live="polite">
			<div v-if="duplicate" class="dup" role="group" aria-label="Use the log already uploaded" @keydown.esc="cancelDuplicate">
				<span>This file is already uploaded as {{ duplicate.label }}. Use that log for this run?</span>
				<ul v-if="duplicate.windows.length" class="wins" aria-label="Run windows already on this log">
					<li v-for="w in duplicate.windows" :key="w.operation_id + w.start">{{ windowLine(w) }}</li>
				</ul>
				<p v-if="duplicate.note" class="d1-note warn">{{ duplicate.note }}</p>
				<span class="row">
					<button type="button" class="d1-btn pri" :disabled="!!busy" @click="link(duplicate.id)">{{ busy === 'link' ? 'Linking…' : 'Use that log' }}</button>
					<button ref="cancelBtn" type="button" class="d1-btn" :disabled="!!busy" @click="cancelDuplicate">Cancel</button>
				</span>
			</div>
		</div>
		<div v-if="picking && candidates" class="pick">
			<template v-if="candidates.length">
				<div class="row">
					<select v-model="chosen" class="d1-input" aria-label="Conform log already uploaded">
						<option v-for="l in candidates" :key="l.log_id" :value="l.log_id">{{ candidateLabel(l) }}</option>
					</select>
					<button type="button" class="d1-btn pri" :disabled="!chosen || !!busy" @click="link(chosen)">{{ busy === 'link' ? 'Linking…' : 'Use this log' }}</button>
				</div>
				<ul v-if="current?.windows.length" class="wins" aria-label="Run windows already on this log">
					<li v-for="w in current.windows" :key="w.operation_id + w.start">{{ windowLine(w) }}</li>
				</ul>
				<p v-if="current && wholeLogNote(current, current.windows)" class="d1-note warn">{{ wholeLogNote(current, current.windows) }}</p>
			</template>
			<p v-else class="d1-note">{{ candidatesEmptyText(operationDate) }}</p>
		</div>
		<p v-if="error" class="d1-note bad" role="alert">{{ error }}</p>
	</div>
</template>

<style scoped>
.source { display: grid; gap: 8px; }
.lead { margin: 0; font-size: var(--fs-md, 13px); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pick { display: grid; gap: 6px; }
.dup { display: grid; gap: 8px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); font-size: var(--fs-sm, 12px); }
.up { position: relative; display: inline-flex; }
.file { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.up:focus-within .d1-btn { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.wins { margin: 0; padding-left: 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.d1-note { overflow-wrap: anywhere; }
</style>
