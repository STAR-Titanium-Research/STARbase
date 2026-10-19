<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
	AppLink, LoadState, PageShell, Section, blankTemplate, canEditTemplate, MAX_COPIES, clampCopies, clampStart, copyAsNew, draftOf, errorText, parseSelectionQuery,
	sampleEntries, slotsPerPage, summaryText, useRequestGate, buildLbxDownload, isLbxTemplate, useExplorerHost, type LabelSample, type LabelTemplate,
} from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import SamplePicker from '../labels/SamplePicker.vue';
import ContactSetting from '../labels/ContactSetting.vue';
import LabelPreview from '../labels/LabelPreview.vue';
import TemplateEditor from '../labels/TemplateEditor.vue';
import { useLabelDocument } from '../labels/useLabelDocument';
import { useLabelSamples } from '../labels/useLabelSamples';
import { useLabelSettings } from '../labels/useLabelSettings';
import { useLabelTemplates } from '../labels/useLabelTemplates';
import { printLabels } from '../labels/printFrame';
import { saveFile } from '../labels/saveFile';
import '../labels/form.css';

// Print labels: pick samples on the left, pick or edit a template on the right, check the live preview, print.
// The preview and the print are one document (renderLabelDocument), so what you see is what comes out.
// Design: docs/superpowers/specs/2026-10-12-label-printing-design.md.
const host = useExplorerHost();
const route = useRoute();
// A Lab Viewer (migration 185) prints with any template and creates, changes and deletes none: the template buttons and the editor are not offered.
const readOnly = computed(() => host.canViewAllAccess?.value === true);

const templates = useLabelTemplates();
const samples = useLabelSamples();
const settings = useLabelSettings();
const copies = ref(1);
const start = ref(1);

// The template being edited, if the editor is open. The preview shows it live; the picker's template is untouched.
const draft = ref<LabelTemplate | null>(null);
const active = computed<LabelTemplate | null>(() => draft.value ?? templates.selected.value);

// With nothing ticked, the editor previews an example label so the layout can still be judged. It is as long as a
// real one (a code of about 22 characters, an email of real length), so a layout that only fits a short example
// shows up as clipped or as a dense QR code here, not on the printed sheet.
const EXAMPLE: LabelSample = {
	id: '00000000-0000-4000-8000-000000000000', code: '1234-AG-MF-2026-10-12', shortId: '1a2b3c4d', nickname: 'FAST control bar', material: 'Ti-6Al-4V',
	date: '2026-10-12', ownerInitials: 'DP', ownerEmail: 'dennis.premoli2@sheffield.ac.uk',
};
const showingExample = computed(() => !!draft.value && samples.selected.value.length === 0);
const previewSamples = computed(() => (showingExample.value ? [EXAMPLE] : samples.selected.value));

const entries = computed(() => sampleEntries(previewSamples.value, showingExample.value ? {} : samples.copyOverrides.value, showingExample.value ? 1 : copies.value));
const { doc, problems, rendering, error: renderError, forPrint } = useLabelDocument({ entries, start, template: active, contactEmail: settings.contactEmail });

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
// Not before the lab contact has loaded (or failed to): a label printed meanwhile would have no Contact line.
const canPrint = computed(() => !!doc.value && doc.value.labels > 0 && problems.value.length === 0 && !showingExample.value && !renderError.value && settings.loaded.value);

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
// The kit's discard dialog (as EditDrawer's): the action waits in `pendingAction` until the user chooses.
const discardOpen = ref(false);
let pendingAction: (() => void) | null = null;
function askDiscard(action: () => void): void {
	if (!dirty.value) return action();
	pendingAction = action;
	discardOpen.value = true;
}
function keepEditing(): void {
	pendingAction = null;
	discardOpen.value = false;
}
function discard(): void {
	const action = pendingAction;
	pendingAction = null;
	discardOpen.value = false;
	action?.();
}

function onPick(e: Event): void {
	const select = e.target as HTMLSelectElement;
	const id = select.value || null;
	if (dirty.value) select.value = templates.selectedId.value ?? ''; // back to the current one until discarding is confirmed
	askDiscard(() => {
		select.value = id ?? '';
		templates.select(id);
		const t = templates.templates.value.find((x) => x.id === id);
		if (draft.value && t) openDraft(draftOf(t));
	});
}
const userId = computed(() => host.user.value?.id ?? null);
// Save and Delete are offered on your own templates, or to an admin: the same rule as the database's row rule
// (user_created = the signed-in user). useCanUpdate asks Directus about one saved record by id; here the answer is
// needed for the draft before and while it is edited, from the row already read, so the rule is applied directly.
const canEditDraft = computed(() => !!draft.value && canEditTemplate(draft.value, userId.value, host.isAdmin.value));
const editLabel = computed(() => (draft.value ? 'Close editor' : 'Edit template'));

function closeEditor(): void {
	askDiscard(() => openDraft(null));
}
function toggleEditor(): void {
	if (draft.value) closeEditor();
	else if (templates.selected.value) openDraft(draftOf(templates.selected.value));
}
function newTemplate(): void {
	askDiscard(() => openDraft(blankTemplate()));
}
function copyTemplate(): void {
	const t = templates.selected.value;
	if (t) askDiscard(() => openDraft(copyAsNew(t)));
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

// ---- download for P-touch (.lbx) ----------------------------------------------------------------
// For the Brother QL-700 with the 62 mm roll: one .lbx per sample for P-touch Editor on the PC that has the printer.
// Same selection as Print; a .lbx has no copy count (set in P-touch's Print dialog), so the file name carries it.
// A single sample is a bare .lbx, several are one .zip.
const showLbx = computed(() => isLbxTemplate(active.value));
const canLbx = computed(() => showLbx.value && canPrint.value);
const lbxError = ref('');
function downloadLbx(): void {
	const t = active.value;
	if (!t || !canLbx.value) return;
	lbxError.value = '';
	try {
		const out = buildLbxDownload(entries.value, t, settings.contactEmail.value);
		if (!out) return;
		saveFile(out.filename, out.mime, out.bytes);
	} catch (e) {
		lbxError.value = `The P-touch files could not be made: ${errorText(e)}`;
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
	void settings.load();
	void samples.loadOptions();
	void samples.runSearch();
	void applyQuery();
});
</script>

<template>
	<ExplorerView title="Print labels">
		<template #headline><AppLink to="/home">Home</AppLink></template>
		<PageShell>
			<p v-if="selectionError" class="d1-note bad" role="alert">{{ selectionError }}</p>
			<p v-if="selectionNote" class="d1-note warn" role="status">{{ selectionNote }}</p>

			<div class="cols">
				<div class="col">
					<Section v-if="draft && !readOnly" :title="draft.id ? `Edit template` : 'New template'">
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
								<template v-if="!readOnly">
									<button type="button" class="lf-btn" :disabled="!templates.selected.value" @click="toggleEditor">{{ editLabel }}</button>
									<button type="button" class="lf-btn" @click="newTemplate">New template</button>
									<button type="button" class="lf-btn" :disabled="!templates.selected.value" @click="copyTemplate">Copy template</button>
								</template>
							</div>
							<ContactSetting :settings="settings" :is-admin="host.isAdmin.value" />
							<p v-if="templates.broken.value.length" class="d1-note warn">{{ templates.broken.value.length }} template{{ templates.broken.value.length === 1 ? ' is' : 's are' }} unreadable and shown greyed out above.</p>
						</LoadState>
					</Section>

					<Section title="Preview">
						<template #actions>
							<button v-if="showLbx" type="button" class="lf-btn" :disabled="!canLbx" @click="downloadLbx">Download for P-touch (.lbx)</button>
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
								<span v-if="settings.loadError.value" class="bad" role="alert"> {{ settings.loadError.value }} The labels print without a Contact line.</span>
							</p>
							<LabelPreview :html="doc?.html ?? null" :page-width-mm="active.pageWidthMm || 210" />
							<p v-if="active.media === 'roll'" class="d1-note hint">
								Roll printers: in the print dialog choose the roll's paper size ({{ active.pageWidthMm }} mm wide) and 100% scale (no "fit to page").
							</p>
							<p v-if="showLbx" class="d1-note hint">
								One file per sample. Open in P-touch Editor on the PC with the QL-700 and set the number of copies in its Print dialog (the file name shows how many you asked for).
							</p>
							<p v-if="lbxError" class="d1-note bad" role="alert">{{ lbxError }}</p>
							<p v-if="printError" class="d1-note bad" role="alert">{{ printError }}</p>
						</template>
					</Section>
				</div>
			</div>

			<v-dialog v-model="discardOpen" @esc="keepEditing">
				<v-card>
					<v-card-title>Discard your changes?</v-card-title>
					<v-card-text>The edits you made to this template have not been saved.</v-card-text>
					<v-card-actions>
						<v-button secondary @click="keepEditing">Keep editing</v-button>
						<v-button kind="danger" @click="discard">Discard</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>
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
