<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
	ConformLogError, candidateLabel, candidatesEmptyText, linkExistingLog, listCandidateLogs, uploadConformLog, windowLine, wholeLogNote,
	type CandidateLog,
} from '@d1/fast-plotting';
import { errorText, useExplorerHost } from '@d1/ui';
import { conformApi } from '../conformApi';

// Where a Conform run's log comes from, for a run that has none: upload the machine's CSV (read as bytes and processed here in the
// browser, the normalised file stored once) or use a log already uploaded (for another run, or for this one before it was unlinked): its
// run window starts empty. A file that is already uploaded is not uploaded again: the person is offered that log. Whatever the helper
// refuses is shown as it says it, e.g. a malformed file. With no run date the list is of logs around today.
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
const duplicate = ref<{ id: string; label: string } | null>(null);

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
		if ('existing' in out) duplicate.value = { id: out.existing.log_id, label: candidateLabel(out.existing) };
		else emit('changed', out.dateWarning ?? '');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
		input.value = '';
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

onMounted(() => { if (props.openPicker) void showPicker(); });
</script>

<template>
	<div class="source">
		<p class="lead">This run has no Conform log yet. Upload the machine's CSV, or use a log already uploaded.</p>
		<div class="row">
			<label class="up">
				<span class="btn" :aria-disabled="busy ? 'true' : undefined">{{ busy === 'upload' ? 'Reading and uploading…' : 'Upload a log' }}</span>
				<input type="file" accept=".csv,text/csv" class="file" :disabled="!!busy" aria-label="Upload a Conform log (CSV)" @change="onFile" />
			</label>
			<button v-if="!picking" type="button" class="btn" :disabled="!!busy" @click="showPicker">Use a log already uploaded</button>
		</div>
		<div v-if="duplicate" class="dup" role="alertdialog" aria-label="This file is already uploaded">
			<span>This file is already uploaded as {{ duplicate.label }}. Use that log for this run?</span>
			<span class="row">
				<button type="button" class="btn primary" :disabled="!!busy" @click="link(duplicate.id)">{{ busy === 'link' ? 'Linking…' : 'Use that log' }}</button>
				<button type="button" class="btn" :disabled="!!busy" @click="duplicate = null">Cancel</button>
			</span>
		</div>
		<div v-if="picking && candidates" class="pick">
			<template v-if="candidates.length">
				<div class="row">
					<select v-model="chosen" aria-label="Conform log already uploaded">
						<option v-for="l in candidates" :key="l.log_id" :value="l.log_id">{{ candidateLabel(l) }}</option>
					</select>
					<button type="button" class="btn primary" :disabled="!chosen || !!busy" @click="link(chosen)">{{ busy === 'link' ? 'Linking…' : 'Use this log' }}</button>
				</div>
				<ul v-if="current?.windows.length" class="wins" aria-label="Run windows already on this log">
					<li v-for="w in current.windows" :key="w.operation_id + w.start">{{ windowLine(w) }}</li>
				</ul>
				<p v-if="current && wholeLogNote(current, current.windows)" class="d1-note warn">{{ wholeLogNote(current, current.windows) }}</p>
			</template>
			<p v-else class="none">{{ candidatesEmptyText(operationDate) }}</p>
		</div>
		<p v-if="error" class="err" role="alert">{{ error }}</p>
	</div>
</template>

<style scoped>
.source { display: grid; gap: 8px; }
.lead { margin: 0; font-size: var(--fs-md); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pick { display: grid; gap: 6px; }
.dup { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); font-size: var(--fs-sm); }
.up { position: relative; display: inline-flex; }
.file { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.btn {
	display: inline-flex; align-items: center; box-sizing: border-box; min-height: 28px; padding: 0 12px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); color: var(--d1-accent, var(--theme--primary));
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: transparent; color: var(--d1-on-accent, #fff); }
.btn:disabled, .btn[aria-disabled='true'] { opacity: 0.55; cursor: default; }
.up:focus-within .btn, .btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
select { min-height: 28px; max-width: 100%; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit; font: inherit; font-size: var(--fs-sm, 12px); padding: 0 8px; }
.wins { margin: 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.warn { color: var(--d1-warn); margin: 0; }
.none { margin: 0; font-size: var(--fs-sm); color: var(--d1-dim); }
.err { margin: 0; font-size: var(--fs-sm); color: var(--d1-bad); overflow-wrap: anywhere; }
</style>
