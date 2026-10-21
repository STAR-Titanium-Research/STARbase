<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { SegmentedControl, useExplorerHost, useRequestGate } from '@d1/ui';
import { OPERATION_FIELDS, operationFilter, operationOption, todayIso } from '../pages/surface/addScanModel';
import type { FoundFile } from './inboxApi';
import { nameOf } from './inboxModel';
import {
	CONDITION_LABEL, CONDITION_NOTE_MAX, NOTES_MAX, SCAN_ADD_LABEL, SCAN_CONDITIONS, SCAN_ITEM_CHOICES, VISIBILITY_WARNING, emptyScanAdd, scanAddProblems, scanItemDef,
	scanItemSearchParams, suggestedScanItem, toScanItemOption, type ScanAddForm, type ScanItemKind, type ScanItemOption,
} from './inboxScan';
import { MIN_QUERY, SEARCH_DEBOUNCE_MS, isSearchable } from './recordSearch';

// The "Add a surface scan" dialog of a found file (spec 2026-10-15-found-files-inbox-design.md section 8): the insert or edge it belongs to, its condition
// (required, nothing chosen to begin with), and optionally the operation that wore it, the day it was scanned, a condition note and notes. It shows the
// visibility warning of the Alicona dialog (pages/surface/AddSurfaceScanDialog.vue, whose conditions, validation and wording it reuses). Inserts, edges and
// operations are read through /items as the signed-in user; the endpoint has the last word and its refusal shows here, with the control it is about marked.
const props = defineProps<{
	modelValue: boolean;
	file: FoundFile | null;
	busy: boolean;
	/** The words of the last refusal (inboxScan.ts scanErrorText), or ''. */
	error: string;
	/** The form control a 400 named: 'condition', 'insert_id', 'edge_id', 'operation_id', 'scanned_on', 'condition_note' or 'notes'. */
	errorField: string;
}>();
const emit = defineEmits<{
	(e: 'update:modelValue', open: boolean): void;
	(e: 'submit', form: ScanAddForm): void;
}>();

const host = useExplorerHost();
const searchGate = useRequestGate();
const opGate = useRequestGate();
const kind = ref<ScanItemKind>('insert');
const form = ref<ScanAddForm>(emptyScanAdd());
const query = ref('');
const results = ref<ScanItemOption[]>([]);
const searching = ref(false);
const searchError = ref('');
const operations = ref<Array<{ text: string; value: string }>>([]);
const operationsError = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

const def = computed(() => scanItemDef(kind.value));
const name = computed(() => (props.file ? nameOf(props.file.rel_path) : ''));
const today = computed(() => todayIso());
const problems = computed(() => (props.file ? scanAddProblems(form.value, props.file, today.value) : ['Choose a file.']));
const touched = computed(() => !!form.value.item || !!form.value.condition);
const close = () => {
	if (!props.busy) emit('update:modelValue', false);
};
const invalid = (...fields: string[]) => (fields.includes(props.errorField) ? 'true' : undefined);

async function loadOperations(item: ScanItemOption | null): Promise<void> {
	const token = opGate.begin();
	operations.value = [];
	operationsError.value = '';
	if (!item) return;
	try {
		const res = await host.api.get('/items/manufacturing_operations', {
			params: {
				filter: JSON.stringify(operationFilter(item.kind === 'edge' ? { edgeId: item.id } : { insertId: item.id })),
				fields: OPERATION_FIELDS,
				sort: ['-operation_date'],
				limit: 100,
			},
		});
		if (!opGate.isCurrent(token)) return;
		operations.value = ((res.data?.data ?? []) as any[]).map(operationOption);
	} catch {
		if (!opGate.isCurrent(token)) return;
		operationsError.value = 'Could not load the operations; you can still add the surface scan without one.';
	}
}

watch(
	() => props.modelValue,
	(open) => {
		if (!open || !props.file) return;
		// nothing is preset but the item the file's path names; the condition is always the person's choice
		const suggested = suggestedScanItem(props.file);
		form.value = emptyScanAdd(suggested);
		kind.value = suggested?.kind ?? 'insert';
		query.value = '';
		results.value = [];
		searchError.value = '';
		void loadOperations(suggested);
	},
	{ immediate: true },
);

async function search(): Promise<void> {
	const q = query.value;
	if (!isSearchable(q)) {
		searchGate.cancel();
		results.value = [];
		searching.value = false;
		return;
	}
	const token = searchGate.begin();
	searching.value = true;
	try {
		const res = await host.api.get(`/items/${def.value.collection}`, { params: scanItemSearchParams(kind.value, q) });
		if (!searchGate.isCurrent(token)) return;
		const rows = Array.isArray(res.data?.data) ? res.data.data : [];
		results.value = rows.map((r: unknown) => toScanItemOption(kind.value, r)).filter((o: ScanItemOption | null): o is ScanItemOption => o !== null);
		searchError.value = '';
	} catch (e: any) {
		if (!searchGate.isCurrent(token)) return;
		results.value = [];
		searchError.value = e?.response?.status === 403 ? `You cannot read ${def.value.label.toLowerCase()}s.` : 'Could not search. Try again.';
	} finally {
		if (searchGate.isCurrent(token)) searching.value = false;
	}
}
function onInput() {
	clearTimeout(timer);
	timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
}
function setKind(k: string) {
	kind.value = k as ScanItemKind;
	// an item belongs to its own kind: switching kind clears it, so the scan never goes to an edge while the dialog shows inserts
	if (form.value.item && form.value.item.kind !== kind.value) choose(null);
	results.value = [];
	void search();
}
function choose(item: ScanItemOption | null) {
	form.value.item = item;
	form.value.operationId = null;
	void loadOperations(item);
}
onBeforeUnmount(() => {
	clearTimeout(timer);
	searchGate.cancel();
	opGate.cancel();
});

const shown = computed(() => {
	const chosen = form.value.item && form.value.item.kind === kind.value ? [form.value.item] : [];
	return [...chosen, ...results.value.filter((r) => r.id !== form.value.item?.id)];
});
const submit = () => {
	if (props.busy || problems.value.length > 0) return;
	emit('submit', { ...form.value, item: form.value.item ? { ...form.value.item } : null });
};
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="scan-card" data-test="add-scan-dialog" role="group" aria-labelledby="add-scan-title">
			<v-card-title id="add-scan-title">{{ SCAN_ADD_LABEL }}: {{ name }}</v-card-title>
			<v-card-text>
				<p class="notice" data-test="visibility-warning">{{ VISIBILITY_WARNING }}</p>

				<div class="fld">
					<span class="lbl">Add it to</span>
					<SegmentedControl :model-value="kind" :options="SCAN_ITEM_CHOICES" label="An insert or an edge" @update:model-value="setKind" />
				</div>
				<label class="fld">
					<span class="lbl">Find an {{ def.label.toLowerCase() }} (at least {{ MIN_QUERY }} characters of its code)</span>
					<input
						v-model="query" type="text" class="in" :placeholder="`${def.label} code`" autocomplete="off" autofocus data-test="scan-item-search"
						:aria-invalid="invalid('insert_id', 'edge_id')" @input="onInput"
					/>
				</label>
				<p v-if="searchError" class="err" role="alert">{{ searchError }}</p>
				<p v-else-if="searching" class="hint" role="status">Searching…</p>
				<ul v-if="shown.length" class="results" role="radiogroup" :aria-label="`${def.label}s`">
					<li v-for="r in shown" :key="r.id">
						<label class="opt" :class="{ on: form.item?.id === r.id }">
							<input type="radio" name="scan-item" :checked="form.item?.id === r.id" @change="choose(r)" />
							<span class="code">{{ r.label }}</span>
							<span v-if="r.detail" class="detail">{{ r.detail }}</span>
							<span v-if="form.item?.id === r.id && file && r.id === file.suggested_record_id" class="detail">named in the file's path</span>
						</label>
					</li>
				</ul>
				<p v-else-if="isSearchable(query) && !searching && !searchError" class="hint">No {{ def.label.toLowerCase() }} matches "{{ query.trim() }}".</p>

				<fieldset class="fld cond">
					<legend class="lbl">Condition <span class="opt-note">(required)</span></legend>
					<div class="radios" role="radiogroup" aria-required="true" :aria-invalid="invalid('condition')">
						<label v-for="c in SCAN_CONDITIONS" :key="c" class="radio" :class="{ on: form.condition === c }">
							<input v-model="form.condition" type="radio" name="scan-condition" :value="c" :data-test="`scan-condition-${c}`" />
							<span>{{ CONDITION_LABEL[c] }}</span>
						</label>
					</div>
				</fieldset>

				<div class="row">
					<label class="fld">
						<span class="lbl">Scanned on <span class="opt-note">(optional)</span></span>
						<input v-model="form.date" type="date" class="in" :max="today" data-test="scan-date" :aria-invalid="invalid('scanned_on')" />
					</label>
					<label class="fld">
						<span class="lbl">Operation that wore it <span class="opt-note">(optional)</span></span>
						<select v-model="form.operationId" class="in" :disabled="!operations.length" data-test="scan-operation" :aria-invalid="invalid('operation_id')">
							<option :value="null">{{ !form.item ? 'Choose an insert or edge first' : operations.length ? 'None' : 'No operation to choose from' }}</option>
							<option v-for="o in operations" :key="o.value" :value="o.value">{{ o.text }}</option>
						</select>
					</label>
				</div>
				<p v-if="operationsError" class="err" role="alert">{{ operationsError }}</p>

				<label class="fld">
					<span class="lbl">Condition note <span class="opt-note">{{ form.condition === 'other' ? '(say what the condition is)' : '(optional)' }}</span></span>
					<textarea v-model="form.conditionNote" class="in area" rows="2" :maxlength="CONDITION_NOTE_MAX" placeholder="For example: after 12 min of turning, flank wear land" data-test="scan-condition-note" :aria-invalid="invalid('condition_note')" />
				</label>
				<label class="fld">
					<span class="lbl">Notes <span class="opt-note">(optional)</span></span>
					<textarea v-model="form.notes" class="in area" rows="2" :maxlength="NOTES_MAX" data-test="scan-notes" :aria-invalid="invalid('notes')" />
				</label>

				<ul v-if="touched && problems.length" class="problems" aria-live="polite" data-test="scan-problems">
					<li v-for="p in problems" :key="p">{{ p }}</li>
				</ul>
				<p v-if="error" class="err" role="alert" data-test="scan-error">{{ error }}</p>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary :disabled="busy" @click="close">Cancel</v-button>
				<v-button :loading="busy" :disabled="busy || problems.length > 0" data-test="scan-confirm" @click="submit">{{ SCAN_ADD_LABEL }}{{ form.item ? ` to ${form.item.label}` : '' }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.scan-card { width: min(560px, calc(100vw - 24px)); }
.notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; font-size: var(--fs-sm, 12px); background: color-mix(in srgb, var(--d1-warn) 12%, transparent); color: var(--theme--foreground); }
.fld { display: flex; flex-direction: column; gap: 3px; margin: 0 0 10px; padding: 0; border: 0; min-width: 0; flex: 1 1 0; }
.lbl { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); padding: 0; }
.opt-note { font-weight: 400; }
.in {
	min-height: 32px; padding: 0 10px; box-sizing: border-box; border: 1px solid var(--theme--border-color); border-radius: 8px; max-width: 100%;
	background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.in[aria-invalid='true'] { border-color: var(--d1-bad); }
.radios[aria-invalid='true'] { outline: 1px solid var(--d1-bad); outline-offset: 3px; border-radius: 8px; }
.area { padding: 6px 10px; resize: vertical; }
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.row .fld { flex: 1 1 200px; }
.results { margin: 0 0 10px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow: auto; }
.opt { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px; cursor: pointer; }
.opt.on { border-color: var(--d1-accent, var(--theme--primary)); background: var(--d1-tile); }
.opt input { margin: 0; }
.code { font-weight: 650; font-size: var(--fs-md, 13px); }
.detail { font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.radios { display: flex; flex-wrap: wrap; gap: 8px; }
.radio { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; min-height: 32px; border: 1px solid var(--d1-line); border-radius: 8px; cursor: pointer; font-size: var(--fs-md, 13px); }
.radio.on { border-color: var(--d1-accent, var(--theme--primary)); background: var(--d1-tile); font-weight: 650; }
.radio input { margin: 0; }
.hint { margin: 0 0 8px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.problems { margin: 0 0 8px; padding: 0; list-style: none; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { margin: 6px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.spacer { flex: 1; }
</style>
