<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
	LoadState, PageShell, Section, blankTemplate, canEditTemplate, MAX_COPIES, clampCopies, clampStart, copyAsNew, draftOf, errorText, parseSelectionQuery,
	sampleEntries, slotsPerPage, summaryText, useRequestGate, type LabelSample, type LabelTemplate,
} from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import { useExplorerHost } from '../explorerHost';
import SamplePicker from '../labels/SamplePicker.vue';
import LabelPreview from '../labels/LabelPreview.vue';
import TemplateEditor from '../labels/TemplateEditor.vue';
import { useLabelDocument } from '../labels/useLabelDocument';
import { useLabelSamples } from '../labels/useLabelSamples';
import { useLabelTemplates } from '../labels/useLabelTemplates';
import { printLabels } from '../labels/printFrame';
import '../labels/form.css';

// Print labels: pick samples on the left, pick or edit a template on the right, check the live preview, print.
// The preview and the print are one document (renderLabelDocument), so what you see is what comes out.
// Design: docs/superpowers/specs/2026-10-12-label-printing-design.md.
const host = useExplorerHost();
const route = useRoute();

const templates = useLabelTemplates();
const samples = useLabelSamples();
const copies = ref(1);
const start = ref(1);

// The template being edited, if the editor is open. The preview shows it live; the picker's template is untouched.
const draft = ref<LabelTemplate | null>(null);
const active = computed<LabelTemplate | null>(() => draft.value ?? templates.selected.value);

// With nothing ticked, the editor previews an example label so the layout can still be judged.
const EXAMPLE: LabelSample = {
	id: '00000000-0000-4000-8000-000000000000', code: 'S-0123', shortId: '1a2b3c4d', nickname: 'bracket A', material: 'Ti-6Al-4V',
	date: '2026-10-01', ownerInitials: 'DP',
};
const showingExample = computed(() => !!draft.value && samples.selected.value.length === 0);
const previewSamples = computed(() => (showingExample.value ? [EXAMPLE] : samples.selected.value));

const entries = computed(() => sampleEntries(previewSamples.value, showingExample.value ? {} : samples.copyOverrides.value, showingExample.value ? 1 : copies.value));
const { doc, problems, rendering, error: renderError, forPrint } = useLabelDocument({ entries, start, template: active });

const slots = computed(() => (active.value ? slotsPerPage(active.value) : 1));
const showStart = computed(() => active.value?.media === 'sheet' && slots.value > 1);
// "Start at" and the copies stay in range. While typing only an overshoot is pulled back (an empty or
// half-typed field is left alone, or backspacing the "1" and typing "4" would give "14"); the field is made
// whole on change (blur / Enter). The document clamps again at render time, so a half-typed value never prints wrong.
// Only while the active template is valid: a half-typed grid in the editor must not move the field.
watch([start, slots], () => {
	if (problems.value.length === 0 && Number.isFinite(start.value) && start.value > slots.value) start.value = slots.value;
});
watch(copies, (v) => {
	if (Number.isFinite(v) && v > MAX_COPIES) copies.value = MAX_COPIES;
});
const tidyStart = () => { if (problems.value.length === 0) start.value = clampStart(start.value, slots.value); };
const tidyCopies = () => { copies.value = clampCopies(copies.value); };

const summary = computed(() => (doc.value ? summaryText(doc.value) : ''));
const canPrint = computed(() => !!doc.value && doc.value.labels > 0 && problems.value.length === 0 && !showingExample.value);

// ---- the template picker -------------------------------------------------------------------------
// A draft opened with openDraft() has a snapshot; the editor is "dirty" when the draft no longer matches it.
// Anything that would throw a dirty draft away asks first. The editor is keyed on draftKey, so each opened
// draft starts with a clean form (no old error or half-answered delete confirmation).
const draftKey = ref(0);
let snapshot = '';
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== snapshot);
function openDraft(t: LabelTemplate | null): void {
	draft.value = t;
	snapshot = t ? JSON.stringify(t) : '';
	draftKey.value++;
}
const confirmDiscard = (): boolean => !dirty.value || window.confirm('Discard your unsaved changes to this template?');

function onPick(e: Event): void {
	const select = e.target as HTMLSelectElement;
	if (!confirmDiscard()) {
		select.value = templates.selectedId.value ?? '';
		return;
	}
	const id = select.value || null;
	templates.select(id);
	const t = templates.templates.value.find((x) => x.id === id);
	if (draft.value && t) openDraft(draftOf(t));
}
const userId = computed(() => host.user.value?.id ?? null);
// Save and Delete are offered on your own templates, or to an admin: the same rule as the database's row rule
// (user_created = the signed-in user). useCanUpdate asks Directus about one saved record by id; here the answer is
// needed for the draft before and while it is edited, from the row already read, so the rule is applied directly.
const canEditDraft = computed(() => !!draft.value && canEditTemplate(draft.value, userId.value, host.isAdmin.value));
const editLabel = computed(() => (draft.value ? 'Close editor' : 'Edit template'));

function closeEditor(): void {
	if (confirmDiscard()) openDraft(null);
}
function toggleEditor(): void {
	if (draft.value) closeEditor();
	else if (templates.selected.value) openDraft(draftOf(templates.selected.value));
}
function newTemplate(): void {
	if (confirmDiscard()) openDraft(blankTemplate());
}
function copyTemplate(): void {
	if (templates.selected.value && confirmDiscard()) openDraft(copyAsNew(templates.selected.value));
}
async function onSaved(id: string): Promise<void> {
	await templates.load(id);
	templates.select(id);
	const t = templates.selected.value;
	openDraft(t ? draftOf(t) : null);
}
async function onDeleted(): Promise<void> {
	openDraft(null);
	templates.select(null);
	await templates.load();
}

// ---- print ---------------------------------------------------------------------------------------
const printError = ref('');
const printing = ref(false);
async function print(): Promise<void> {
	const out = forPrint();
	if (!out || out.labels === 0) return;
	printError.value = '';
	printing.value = true;
	try {
		await printLabels(out.html);
	} catch (e) {
		printError.value = `Could not open the print dialog: ${errorText(e)}`;
	} finally {
		printing.value = false;
	}
}

// ---- ?ids= and ?codes= --------------------------------------------------------------------------
const selectionNote = ref('');
const selectionError = ref('');
// The samples the address put on the selection. A new ?ids= / ?codes= replaces them; the ones ticked by hand stay.
let fromUrl: string[] = [];
const queryGate = useRequestGate();
async function applyQuery(): Promise<void> {
	const token = queryGate.begin();
	const { ids, codes } = parseSelectionQuery(route.query);
	selectionError.value = '';
	selectionNote.value = '';
	if (!ids.length && !codes.length) return;
	try {
		const { found, missing } = await samples.lookup(ids, codes);
		if (!queryGate.isCurrent(token)) return; // a newer address replaced this one
		samples.removeMany(fromUrl);
		// Only samples that were not already selected count as URL-driven: one ticked by hand stays when the address changes.
		const had = new Set(samples.selected.value.map((s) => s.id));
		const fresh = found.filter((s) => !had.has(s.id));
		samples.add(fresh);
		fromUrl = fresh.map((s) => s.id);
		if (missing.length) selectionNote.value = `Not found, or not visible to you: ${missing.join(', ')}.`;
	} catch (e) {
		if (!queryGate.isCurrent(token)) return;
		selectionError.value = `Could not load the preselected samples: ${errorText(e)}`;
	}
}
onBeforeUnmount(() => queryGate.cancel());
// Keyed on what the address asks for, so an unrelated route change (another query parameter) does not re-run it.
watch(() => JSON.stringify(parseSelectionQuery(route.query)), () => void applyQuery());

onMounted(() => {
	void templates.load();
	void samples.loadOptions();
	void samples.runSearch();
	void applyQuery();
});
</script>

<template>
	<ExplorerView title="Print labels">
		<PageShell>
			<nav class="d1-crumbs"><router-link to="/home">Home</router-link><span>›</span><span>Print labels</span></nav>

			<p v-if="selectionError" class="d1-note bad" role="alert">{{ selectionError }}</p>
			<p v-if="selectionNote" class="d1-note warn" role="status">{{ selectionNote }}</p>

			<div class="cols">
				<div class="col">
					<Section v-if="draft" :title="draft.id ? `Edit template` : 'New template'">
						<TemplateEditor
							:key="draftKey"
							:model-value="draft"
							@update:model-value="draft = $event"
							:can-edit="canEditDraft"
							:is-admin="host.isAdmin.value"
							:problems="problems"
							@saved="onSaved"
							@deleted="onDeleted"
							@close="closeEditor"
						/>
					</Section>
					<SamplePicker :data="samples" v-model:copies="copies" @tidy-copies="tidyCopies" />
				</div>

				<div class="col">
					<Section title="Template">
						<LoadState :loading="templates.loading.value && !templates.templates.value.length" :error="templates.error.value" loading-text="Loading templates…">
							<div class="lf-row">
								<label class="lf-field grow">Template
									<select :value="templates.selectedId.value ?? ''" aria-label="Label template" @change="onPick">
										<option v-if="!templates.selectedId.value" value="" disabled>Choose a template</option>
										<option v-for="t in templates.templates.value" :key="t.id ?? t.name" :value="t.id">{{ t.name }}{{ t.isDefault ? ' (default)' : '' }}</option>
										<option v-for="b in templates.broken.value" :key="b.id ?? b.name" disabled :value="b.id ?? ''">{{ b.name }} (cannot be used: {{ b.reason }})</option>
									</select>
								</label>
								<label v-if="showStart" class="lf-field start">Start at label
									<input v-model.number="start" type="number" min="1" :max="slots" step="1" @change="tidyStart" />
								</label>
							</div>
							<div class="lf-row tools">
								<button type="button" class="lf-btn" :disabled="!templates.selected.value" @click="toggleEditor">{{ editLabel }}</button>
								<button type="button" class="lf-btn" @click="newTemplate">New template</button>
								<button type="button" class="lf-btn" :disabled="!templates.selected.value" @click="copyTemplate">Copy template</button>
							</div>
							<p v-if="templates.broken.value.length" class="d1-note warn">{{ templates.broken.value.length }} template{{ templates.broken.value.length === 1 ? ' is' : 's are' }} unreadable and shown greyed out above.</p>
						</LoadState>
					</Section>

					<Section title="Preview">
						<template #actions>
							<button type="button" class="lf-btn pri" :disabled="!canPrint || printing" @click="print">Print</button>
						</template>
						<LoadState v-if="!active" empty :empty-text="templates.loading.value ? 'Loading templates…' : 'No template to preview. Create one, or ask an admin.'" />
						<template v-else>
							<ul v-if="problems.length && !draft" class="problems" role="alert">
								<li v-for="p in problems" :key="p">{{ p }}</li>
							</ul>
							<p v-if="renderError" class="d1-note bad" role="alert">{{ renderError }}</p>
							<p class="d1-note summary" role="status" aria-live="polite">
								<template v-if="showingExample">Example label (tick samples to preview them).</template>
								<template v-else-if="!samples.selected.value.length">Tick samples to preview their labels.</template>
								<template v-else-if="summary">{{ summary }}</template>
								<span v-if="rendering" class="d1-note"> Updating…</span>
							</p>
							<LabelPreview :html="doc?.html ?? null" :page-width-mm="active.pageWidthMm || 210" />
							<p v-if="active.media === 'roll'" class="d1-note hint">
								Roll printers: in the print dialog choose the roll's paper size ({{ active.pageWidthMm }} mm wide) and 100% scale (no "fit to page").
							</p>
							<p v-if="printError" class="d1-note bad" role="alert">{{ printError }}</p>
						</template>
					</Section>
				</div>
			</div>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.grow { flex: 1 1 220px; }
.start { width: 140px; }
.tools { margin-top: 10px; }
.summary { margin-bottom: 8px; }
.hint { margin-top: 8px; }
.problems { margin: 0 0 8px; padding: 8px 12px 8px 28px; border-radius: 8px; font-size: var(--fs-sm, 12px); color: var(--d1-warn); background: color-mix(in srgb, var(--theme--warning) 12%, transparent); }
@media (max-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
