<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { MeasurementRow } from './measurements';
import { rowText } from './measurements';
import type { MeasurementsStatus } from './useMeasurements';

// The Measurements list in the view box's View rail (spec 2026-10-20-inbox-file-viewer-design.md decision 6): the shapes saved on this file as "1 Line 212 µm",
// "2 Circle Ø 88 µm", "3 Polygon 12,400 µm²". Click a row to highlight its shape on the picture (click again to let go); the pencil renames it in place (Enter keeps,
// Esc drops; an empty name goes back to Line, Circle or Polygon); the bin asks first and then deletes; Copy CSV puts the list on the clipboard for a spreadsheet. A shape the
// person may not change has neither the pencil nor the bin. It only reports what was asked (the page does it and keeps the list).
const props = defineProps<{
	rows: MeasurementRow[];
	selectedId: string | null;
	status: MeasurementsStatus;
	/** Why the list could not be read, or the last change failed ("" for neither). */
	error: string;
	/** The shape whose rename or delete is under way, or 'save'. */
	busyId: string | null;
	copied: boolean;
}>();
const emit = defineEmits<{
	(e: 'select', id: string): void;
	(e: 'rename', id: string, label: string): void;
	(e: 'remove', id: string): void;
	(e: 'copy'): void;
	(e: 'retry'): void;
}>();

const editing = ref<string | null>(null);
const text = ref('');
const confirming = ref<string | null>(null);
const input = ref<HTMLInputElement[] | null>(null);
// a row that is gone (deleted, or another file) cannot stay in the middle of a rename or a question
watch(() => props.rows.map((r) => r.id).join(), () => {
	if (editing.value && !props.rows.some((r) => r.id === editing.value)) editing.value = null;
	if (confirming.value && !props.rows.some((r) => r.id === confirming.value)) confirming.value = null;
});

async function startEdit(r: MeasurementRow): Promise<void> {
	confirming.value = null;
	editing.value = r.id;
	text.value = r.label;
	await nextTick();
	input.value?.[0]?.focus();
	input.value?.[0]?.select();
}
function commit(): void {
	const id = editing.value;
	if (id === null) return;
	editing.value = null;
	const row = props.rows.find((r) => r.id === id);
	const label = text.value.trim();
	if (row && label !== row.label) emit('rename', id, label);
}
const cancel = (): void => {
	editing.value = null;
};
function ask(r: MeasurementRow): void {
	editing.value = null;
	confirming.value = r.id;
}
function remove(id: string): void {
	confirming.value = null;
	emit('remove', id);
}
</script>

<template>
	<div class="ml" data-test="measurements">
		<p v-if="status === 'loading'" class="hint" aria-busy="true" data-test="measurements-loading">Loading the saved shapes…</p>
		<template v-else-if="status === 'error'">
			<p class="hint bad" role="alert" data-test="measurements-error">{{ error || 'Could not load the measurements.' }}</p>
			<button type="button" class="lf-link" data-test="measurements-retry" @click="emit('retry')">Try again</button>
		</template>
		<template v-else>
			<ul v-if="rows.length" class="list" aria-label="Saved measurements">
				<li v-for="r in rows" :key="r.id" class="item" :data-test="`measurement-${r.n}`" :data-id="r.id">
					<div class="row" :class="{ on: r.id === selectedId }">
						<template v-if="editing === r.id">
							<input
								ref="input"
								v-model="text"
								type="text"
								class="d1-input name"
								maxlength="120"
								:placeholder="r.kind === 'line' ? 'Line' : r.kind === 'circle' ? 'Circle' : 'Polygon'"
								:aria-label="`Name of shape ${r.n}`"
								data-test="rename-input"
								@keydown.enter.prevent="commit"
								@keydown.esc.prevent.stop="cancel"
								@blur="commit"
							/>
						</template>
						<template v-else>
							<button type="button" class="pick" :aria-pressed="r.id === selectedId" :aria-label="rowText(r)" :title="r.author ? `Saved by ${r.author}` : undefined" data-test="measurement-select" @click="emit('select', r.id)">
								<span class="no">{{ r.n }}</span>
								<span class="nm" :class="{ named: r.label !== '' }">{{ r.name }}</span>
								<span v-if="r.value" class="val">{{ r.value }}</span>
							</button>
							<template v-if="r.canEdit">
								<button type="button" class="icon-btn" :aria-label="`Rename shape ${r.n}`" title="Rename" :disabled="busyId !== null" data-test="measurement-rename" @click="startEdit(r)"><v-icon name="edit" small /></button>
								<button type="button" class="icon-btn" :aria-label="`Delete shape ${r.n}`" title="Delete" :disabled="busyId !== null" data-test="measurement-delete" @click="ask(r)"><v-icon name="delete" small /></button>
							</template>
						</template>
					</div>
					<div v-if="confirming === r.id" class="ask" role="group" :aria-label="`Delete shape ${r.n}?`" data-test="measurement-confirm">
						<span class="hint">Delete "{{ rowText(r) }}"?</span>
						<span class="acts">
							<button type="button" class="d1-btn danger" data-test="measurement-delete-yes" @click="remove(r.id)">Delete</button>
							<button type="button" class="d1-btn" data-test="measurement-delete-no" @click="confirming = null">Keep</button>
						</span>
					</div>
				</li>
			</ul>
			<p v-else class="hint" data-test="measurements-empty">Nothing saved yet. Draw a shape, then press Save (or Enter).</p>
			<p v-if="error" class="hint bad" role="alert" data-test="measurements-problem">{{ error }}</p>
			<button v-if="rows.length" type="button" class="lf-link" data-test="copy-csv" @click="emit('copy')">{{ copied ? 'Copied' : 'Copy CSV' }}</button>
		</template>
	</div>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped src="./viewRail.css"></style>
<style scoped>
.ml { align-self: stretch; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.hint.bad { color: var(--d1-bad); }
.list { align-self: stretch; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.row { display: flex; align-items: center; gap: 2px; border-radius: 8px; }
.row.on { background: var(--d1-tint); }
.pick {
	flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; padding: 4px 6px; border: 0; border-radius: 8px;
	background: none; color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px); line-height: 1.3; text-align: left; cursor: pointer;
}
.pick:hover { background: var(--d1-tile); }
.pick:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.row.on .pick:hover { background: none; }
.no, .val { font-variant-numeric: tabular-nums; }
.no { color: var(--d1-dim); }
.nm { overflow-wrap: anywhere; }
.nm.named { font-weight: 650; }
.val { color: var(--d1-dim); }
.icon-btn:disabled { opacity: 0.45; cursor: default; }
.name { flex: 1 1 auto; min-width: 0; }
.ask { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 6px; }
.acts { display: flex; gap: 6px; }
</style>
