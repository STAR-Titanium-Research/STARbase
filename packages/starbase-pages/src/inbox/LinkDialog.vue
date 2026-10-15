<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { SegmentedControl, useExplorerHost, useRequestGate } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { DOCUMENT_NOTICE, LINK_TARGETS, linkTarget, nameOf, needsReadNotice, suggestionOf } from './inboxModel';
import { MIN_QUERY, SEARCH_DEBOUNCE_MS, isSearchable, searchParams, toOption, type RecordOption } from './recordSearch';

// The Link dialog: choose the sample, operation or test a found file belongs to (Change, or Link on a file with no suggestion), or
// confirm the suggestion of a document (linking reads it once to fingerprint it, and the dialog says so). Records are searched through
// /items as the signed-in user; whether the person may EDIT the one they chose is the endpoint's call, and its refusal shows here.
const props = defineProps<{
	modelValue: boolean;
	file: FoundFile | null;
	busy: boolean;
	/** The endpoint's message when the last attempt was refused. */
	error: string;
}>();
const emit = defineEmits<{
	(e: 'update:modelValue', open: boolean): void;
	(e: 'choose', record: { collection: string; id: string; label: string }): void;
}>();

const host = useExplorerHost();
const gate = useRequestGate();
const collection = ref<string>(LINK_TARGETS[0].collection);
const query = ref('');
const results = ref<RecordOption[]>([]);
const searching = ref(false);
const searchError = ref('');
const picked = ref<RecordOption | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

const target = computed(() => linkTarget(collection.value) ?? LINK_TARGETS[0]);
const name = computed(() => (props.file ? nameOf(props.file.rel_path) : ''));
const reads = computed(() => !!props.file && needsReadNotice(props.file.kind));
const close = () => emit('update:modelValue', false);
const kinds = LINK_TARGETS.map((t) => ({ value: t.collection, label: t.noun[0].toUpperCase() + t.noun.slice(1) }));

// The suggestion, when there is one the page can link: chosen to begin with, so a document is confirmed with one click.
function suggestedOption(f: FoundFile): RecordOption | null {
	const s = suggestionOf(f);
	if (!s?.target || !f.suggested_record_id) return null;
	return { collection: s.target.collection, id: f.suggested_record_id, label: s.record, detail: s.text };
}

watch(
	() => props.modelValue,
	(open) => {
		if (!open || !props.file) return;
		const s = suggestedOption(props.file);
		picked.value = s;
		collection.value = s?.collection ?? LINK_TARGETS[0].collection;
		query.value = '';
		results.value = [];
		searchError.value = '';
	},
	{ immediate: true },
);

async function search() {
	const q = query.value;
	if (!isSearchable(q)) {
		gate.cancel();
		results.value = [];
		searching.value = false;
		return;
	}
	const token = gate.begin();
	searching.value = true;
	try {
		const res = await host.api.get(`/items/${target.value.collection}`, { params: searchParams(target.value, q) });
		if (!gate.isCurrent(token)) return;
		const rows = Array.isArray(res.data?.data) ? res.data.data : [];
		results.value = rows.map((r: unknown) => toOption(target.value, r)).filter((o: RecordOption | null): o is RecordOption => o !== null);
		searchError.value = '';
	} catch (e: any) {
		if (!gate.isCurrent(token)) return;
		results.value = [];
		searchError.value = e?.response?.status === 403 ? `You cannot read ${target.value.noun}s.` : 'Could not search. Try again.';
	} finally {
		if (gate.isCurrent(token)) searching.value = false;
	}
}
function onInput() {
	clearTimeout(timer);
	timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
}
function setCollection(c: string) {
	collection.value = c;
	// A chosen record belongs to its own kind: switching kind clears it, so Link never links to a sample while the dialog shows tests.
	if (picked.value && picked.value.collection !== c) picked.value = null;
	results.value = [];
	void search();
}
onBeforeUnmount(() => {
	clearTimeout(timer);
	gate.cancel();
});

const shown = computed(() => {
	const s = picked.value && picked.value.collection === collection.value ? [picked.value] : [];
	return [...s, ...results.value.filter((r) => !(picked.value && r.id === picked.value.id))];
});
const submit = () => {
	if (picked.value) emit('choose', { collection: picked.value.collection, id: picked.value.id, label: picked.value.label });
};
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="link-card">
			<v-card-title>Link {{ name }}</v-card-title>
			<v-card-text>
				<p class="lead">Choose the record this file belongs to. It shows on that record's page; the file itself stays where it is on the share.</p>
				<div class="kind"><SegmentedControl :model-value="collection" :options="kinds" label="Kind of record" @update:model-value="setCollection" /></div>
				<label class="fld">
					<span class="lbl">Find a {{ target.noun }} (at least {{ MIN_QUERY }} characters; a short ID works too)</span>
					<input v-model="query" type="text" class="in" :placeholder="`${target.noun[0].toUpperCase()}${target.noun.slice(1)} code or name`" autocomplete="off" autofocus data-test="link-search" @input="onInput" />
				</label>
				<p v-if="searchError" class="err" role="alert">{{ searchError }}</p>
				<p v-else-if="searching" class="hint" role="status">Searching…</p>
				<ul v-if="shown.length" class="results" role="radiogroup" :aria-label="`${target.noun}s`">
					<li v-for="r in shown" :key="r.id">
						<label class="opt" :class="{ on: picked?.id === r.id }">
							<input type="radio" name="inbox-record" :checked="picked?.id === r.id" @change="picked = r" />
							<span class="code">{{ r.label }}</span>
							<span v-if="r.detail" class="detail">{{ r.detail }}</span>
							<span v-if="picked?.id === r.id && file && r.id === file.suggested_record_id" class="detail">suggested</span>
						</label>
					</li>
				</ul>
				<p v-else-if="isSearchable(query) && !searching && !searchError" class="hint">No {{ target.noun }} matches "{{ query.trim() }}".</p>
				<p v-if="reads" class="notice" data-test="read-notice">{{ DOCUMENT_NOTICE }}</p>
				<p class="hint">You need to be able to edit the record to link a file to it.</p>
				<p v-if="error" class="err" role="alert" data-test="link-error">{{ error }}</p>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary @click="close">Cancel</v-button>
				<v-button :loading="busy" :disabled="!picked" @click="submit">Link{{ picked ? ` to ${picked.label}` : '' }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.link-card { width: min(560px, calc(100vw - 24px)); }
.lead { margin: 0 0 10px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.kind { margin-bottom: 10px; }
.fld { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.lbl { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.in {
	height: 32px; padding: 0 10px; box-sizing: border-box; border: 1px solid var(--theme--border-color); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.results { margin: 0 0 8px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; }
.opt { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px; cursor: pointer; }
.opt.on { border-color: var(--d1-accent, var(--theme--primary)); background: var(--d1-tile); }
.opt input { margin: 0; }
.code { font-weight: 650; font-size: var(--fs-md, 13px); }
.detail { font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.hint { margin: 4px 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.notice { margin: 8px 0; padding: 8px 10px; border-radius: 8px; font-size: var(--fs-sm, 12px); background: color-mix(in srgb, var(--d1-warn) 12%, transparent); color: var(--theme--foreground); }
.err { margin: 6px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.spacer { flex: 1; }
</style>
