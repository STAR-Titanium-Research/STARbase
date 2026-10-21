<script setup lang="ts">
import { ref } from 'vue';
import { ConformLogError, formatUkDateTime, linkExistingLog, listCandidateLogs, uploadConformLog, type ConformLogRow } from '@d1/fast-plotting';
import { errorText, useExplorerHost } from '@d1/ui';
import { conformApi } from '../conformApi';

// Where a Conform run's log comes from, for a run that has none: upload the machine's CSV (processed here in the browser, the normalised
// file stored once) or use a log already uploaded for another run on the same machine (its run window starts empty). Whatever the helper
// refuses is shown as it says it, e.g. a malformed file.
const props = defineProps<{ operationId: string; equipmentId: string | null; operationDate: string | null }>();
const emit = defineEmits<{ changed: [dateWarning: string] }>();

const host = useExplorerHost();
const api = () => conformApi(host.api);

const busy = ref<'upload' | 'link' | 'list' | null>(null);
const error = ref('');
const picking = ref(false);
const candidates = ref<ConformLogRow[] | null>(null);
const chosen = ref('');

const messageOf = (e: unknown): string => (e instanceof ConformLogError ? e.message : errorText(e));

async function onFile(ev: Event): Promise<void> {
	const input = ev.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file || busy.value) return;
	busy.value = 'upload';
	error.value = '';
	try {
		const out = await uploadConformLog(api(), { operation_id: props.operationId, equipment_id: props.equipmentId, operation_date: props.operationDate }, { name: file.name, text: await file.text() });
		emit('changed', out.dateWarning ?? '');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
		input.value = '';
	}
}

async function openPicker(): Promise<void> {
	if (busy.value) return;
	picking.value = true;
	busy.value = 'list';
	error.value = '';
	try {
		candidates.value = await listCandidateLogs(api(), props.equipmentId, props.operationDate ?? new Date().toISOString());
		chosen.value = candidates.value[0]?.log_id ?? '';
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
	}
}

async function link(): Promise<void> {
	if (!chosen.value || busy.value) return;
	busy.value = 'link';
	error.value = '';
	try {
		await linkExistingLog(api(), props.operationId, chosen.value);
		emit('changed', '');
	} catch (e) {
		error.value = messageOf(e);
	} finally {
		busy.value = null;
	}
}

const optionText = (l: ConformLogRow): string => `${l.source_filename} · ${formatUkDateTime(l.log_start)}`;
</script>

<template>
	<div class="source">
		<p class="lead">This run has no Conform log yet. Upload the machine's CSV, or use a log already uploaded for another run.</p>
		<div class="row">
			<label class="up">
				<span class="btn" :aria-disabled="busy ? 'true' : undefined">{{ busy === 'upload' ? 'Reading and uploading…' : 'Upload a log' }}</span>
				<input type="file" accept=".csv,text/csv" class="file" :disabled="!!busy" aria-label="Upload a Conform log (CSV)" @change="onFile" />
			</label>
			<button v-if="!picking" type="button" class="btn" :disabled="!!busy" @click="openPicker">Use a log already uploaded</button>
		</div>
		<div v-if="picking && candidates" class="pick">
			<template v-if="candidates.length">
				<select v-model="chosen" aria-label="Conform log already uploaded">
					<option v-for="l in candidates" :key="l.log_id" :value="l.log_id">{{ optionText(l) }}</option>
				</select>
				<button type="button" class="btn primary" :disabled="!chosen || !!busy" @click="link">{{ busy === 'link' ? 'Linking…' : 'Use this log' }}</button>
			</template>
			<p v-else class="none">No Conform log from this machine starts within a day of this run's date.</p>
		</div>
		<p v-if="error" class="err" role="alert">{{ error }}</p>
	</div>
</template>

<style scoped>
.source { display: grid; gap: 8px; }
.lead { margin: 0; font-size: var(--fs-md); }
.row, .pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
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
.none { margin: 0; font-size: var(--fs-sm); color: var(--d1-dim); }
.err { margin: 0; font-size: var(--fs-sm); color: var(--d1-bad); overflow-wrap: anywhere; }
</style>
