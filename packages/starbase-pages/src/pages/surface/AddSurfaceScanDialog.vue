<script setup lang="ts">
// Add a surface scan to a cutting insert or an insert edge: a file from the library, the condition the item was in,
// a note, the day it was scanned and, if known, the operation that wore it. A plain Directus create on
// surface_scans as the signed-in user (permissions and hooks apply); the render worker picks the new row up. The
// dialog always shows that the file becomes visible to every lab member (spec, decision 6). A create has no
// version to clash with, so the refusals handled here are permission, a file already added, and validation.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useExplorerHost, useRequestGate } from '@d1/ui';
import {
	emptyForm, FILE_FIELDS, fileFilter, formatBytes, formProblems, normaliseFile, OPERATION_FIELDS, operationFilter, operationOption, todayIso, VISIBILITY_WARNING, type LibraryFile,
} from './addScanModel';
import { createErrors, createScan } from './scanApi';
import { CONDITION_LABEL, SCAN_CONDITIONS } from './scanModel';

const props = defineProps<{
	modelValue: boolean;
	insertId: string;
	/** Set on an edge page: the scan then belongs to this edge. Null on an insert page: it belongs to the insert. */
	edgeId?: string | null;
	/** What the scan is of, in words: "Edge CNMG12-1-3B". */
	itemLabel: string;
	/** Files this item already has as a scan (the database refuses a second one). */
	takenFileIds: string[];
}>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'added'): void }>();

const host = useExplorerHost();
const searchGate = useRequestGate();
const opGate = useRequestGate();

const form = ref(emptyForm());
const text = ref('');
const hits = ref<LibraryFile[]>([]);
const searching = ref(false);
const searchError = ref('');
const operations = ref<Array<{ text: string; value: string }>>([]);
const operationsError = ref('');
const saving = ref(false);
const errors = ref<string[]>([]);
let timer: ReturnType<typeof setTimeout> | null = null;

const close = () => {
	if (!saving.value) emit('update:modelValue', false);
};
const conditionItems = SCAN_CONDITIONS.map((c) => ({ text: CONDITION_LABEL[c], value: c }));
const today = computed(() => todayIso());
const problems = computed(() => formProblems(form.value, today.value, props.takenFileIds));
const taken = (f: LibraryFile) => props.takenFileIds.includes(f.id);

async function search(): Promise<void> {
	const token = searchGate.begin();
	searching.value = true;
	searchError.value = '';
	try {
		const res = await host.api.get('/files', { params: { filter: JSON.stringify(fileFilter(text.value)), fields: FILE_FIELDS, sort: ['-uploaded_on'], limit: 12 } });
		if (!searchGate.isCurrent(token)) return;
		hits.value = ((res.data?.data ?? []) as any[]).map(normaliseFile).filter((f): f is LibraryFile => f !== null);
	} catch (e: any) {
		if (!searchGate.isCurrent(token)) return;
		hits.value = [];
		searchError.value = `Could not search the file library: ${e?.response?.data?.errors?.[0]?.message || e?.message || 'request failed'}`;
	} finally {
		if (searchGate.isCurrent(token)) searching.value = false;
	}
}

async function loadOperations(): Promise<void> {
	const token = opGate.begin();
	operations.value = [];
	operationsError.value = '';
	try {
		const res = await host.api.get('/items/manufacturing_operations', {
			params: {
				filter: JSON.stringify(operationFilter({ insertId: props.insertId, edgeId: props.edgeId })),
				fields: OPERATION_FIELDS,
				sort: ['-operation_date'],
				limit: 100,
			},
		});
		if (!opGate.isCurrent(token)) return;
		operations.value = ((res.data?.data ?? []) as any[]).map(operationOption);
	} catch (e: any) {
		if (!opGate.isCurrent(token)) return;
		operationsError.value = 'Could not load the operations; you can still add the scan without one.';
	}
}

watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		form.value = emptyForm();
		text.value = '';
		hits.value = [];
		errors.value = [];
		saving.value = false;
		void search();
		void loadOperations();
	},
	{ immediate: true },
);

watch(text, () => {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => void search(), 250);
});
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	searchGate.cancel();
	opGate.cancel();
});

const pick = (f: LibraryFile) => {
	if (!taken(f)) form.value.file = f;
};

async function add(): Promise<void> {
	if (saving.value || problems.value.length) return;
	const f = form.value;
	saving.value = true;
	errors.value = [];
	try {
		await createScan(host.api, {
			insertId: props.insertId,
			edgeId: props.edgeId,
			fileId: f.file!.id,
			condition: f.condition!,
			conditionNote: f.note,
			scannedOn: f.date,
			operationId: f.operationId,
		});
		emit('added');
		emit('update:modelValue', false);
	} catch (e) {
		errors.value = createErrors(e);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="add-card" data-testid="add-surface-scan">
			<v-card-title>Add a surface scan to {{ itemLabel }}</v-card-title>
			<v-card-text>
				<v-notice type="warning" class="warn" data-testid="visibility-warning">{{ VISIBILITY_WARNING }}</v-notice>

				<div class="fld">
					<label>File from the library</label>
					<template v-if="!form.file">
						<v-input v-model="text" placeholder="Search by file name…" autofocus />
						<p v-if="searchError" class="err" role="alert">{{ searchError }}</p>
						<ul v-if="hits.length" class="hits" aria-label="Library files">
							<li v-for="h in hits" :key="h.id">
								<button type="button" class="hit" :disabled="taken(h)" @click="pick(h)">
									<span class="name">{{ h.name }}</span>
									<span v-if="h.path" class="path">{{ h.path }}</span>
									<span v-if="taken(h)" class="tag">already a surface scan here</span>
									<span v-else-if="h.size !== null" class="size">{{ formatBytes(h.size) }}</span>
								</button>
							</li>
						</ul>
						<p v-else-if="!searching && !searchError" class="hint">No topography file in the library matches. Files are listed by their ending (.al3d and similar).</p>
					</template>
					<div v-else class="chosen">
						<strong>{{ form.file.name }}</strong><span v-if="form.file.path" class="path">{{ form.file.path }}</span>
						<button type="button" class="link" @click="form.file = null">Change</button>
					</div>
				</div>

				<div class="row">
					<div class="fld">
						<label>Condition</label>
						<v-select v-model="form.condition" :items="conditionItems" placeholder="Choose…" />
					</div>
					<div class="fld">
						<label>Scanned on <span class="opt">(optional)</span></label>
						<v-input v-model="form.date" type="date" />
					</div>
				</div>

				<div class="fld">
					<label>Note <span class="opt">{{ form.condition === 'other' ? '(say what the condition is)' : '(optional)' }}</span></label>
					<v-textarea v-model="form.note" placeholder="For example: after 12 min of turning, flank wear land" />
				</div>

				<div class="fld">
					<label>Operation that wore it <span class="opt">(optional)</span></label>
					<v-select v-model="form.operationId" :items="operations" show-deselect :placeholder="operations.length ? 'None' : 'No operation to choose from'" :disabled="!operations.length" />
					<p v-if="operationsError" class="err" role="alert">{{ operationsError }}</p>
				</div>

				<ul v-if="form.file || form.condition" class="problems" aria-live="polite">
					<li v-for="p in problems" :key="p">{{ p }}</li>
				</ul>
				<div v-if="errors.length" class="err" role="alert">
					<p v-for="m in errors" :key="m">{{ m }}</p>
				</div>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary :disabled="saving" @click="close">Cancel</v-button>
				<v-button :disabled="problems.length > 0" :loading="saving" @click="add">Add surface scan</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.add-card { width: min(560px, calc(100vw - 24px)); }
.warn { margin-bottom: 14px; }
.fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; min-width: 0; flex: 1 1 0; }
.fld label { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.opt { font-weight: 400; }
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.row .fld { flex: 1 1 200px; }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.err p { margin: 0 0 4px; }
.problems { margin: 0 0 8px; padding: 0; list-style: none; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.spacer { flex: 1; }
.hits { list-style: none; margin: 0; padding: 4px 0; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); max-height: 220px; overflow: auto; }
.hit { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; width: 100%; padding: 6px 12px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.hit:hover:not(:disabled), .hit:focus-visible { background: var(--d1-tile); outline: none; }
.hit:disabled { cursor: not-allowed; opacity: 0.6; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.path { font-size: var(--fs-xs, 11px); color: var(--d1-dim); overflow-wrap: anywhere; }
.size { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.tag { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-warn); }
.chosen { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; cursor: pointer; }
</style>
