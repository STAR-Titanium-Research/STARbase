<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from 'vue';
import { ARRANGEMENTS, MEDIA, copyAsNew, draftOf, type Arrangement, type LabelTemplate, type Media } from '@d1/ui';
import FieldListEditor from './FieldListEditor.vue';
import { useTemplateSave } from './useTemplateSave';
import './form.css';

// The template editor: geometry, arrangement and fields, with the preview of the page reading the draft as
// you type. `modelValue` is the draft (the page owns it); every edit emits a fresh copy. Save and Delete go
// through the SDK as the signed-in user and are offered only where the server would allow them: on your own
// templates, or as an admin. Anyone may create ("Save as new"). The Default switch is for admins only (the
// column is admin-only in the database).
const props = defineProps<{ modelValue: LabelTemplate; canEdit: boolean; isAdmin: boolean; all: LabelTemplate[]; problems: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [LabelTemplate]; saved: [string]; deleted: []; close: [] }>();

const local = reactive<LabelTemplate>(draftOf(props.modelValue));
let lastEmitted: LabelTemplate = toRaw(props.modelValue);
// The parent stores what we emit in a ref, so it hands it back as a reactive proxy: compare the raw object, or
// our own edit would look like a new draft and reset the form in a loop.
watch(() => props.modelValue, (v) => {
	if (toRaw(v) !== lastEmitted) Object.assign(local, draftOf(v));
});
watch(local, () => {
	lastEmitted = draftOf(local);
	emit('update:modelValue', lastEmitted);
}, { deep: true });

const MEDIA_LABEL: Record<Media, string> = { sheet: 'Sheet of labels', roll: 'Roll (one label per page)' };
const ARRANGEMENT_LABEL: Record<Arrangement, string> = { qr_top: 'QR code on top', qr_left: 'QR code on the left', text_only: 'Text only' };

interface Num { key: 'pageWidthMm' | 'pageHeightMm' | 'columns' | 'rows' | 'labelWidthMm' | 'labelHeightMm' | 'marginTopMm' | 'marginLeftMm' | 'gapXMm' | 'gapYMm' | 'paddingMm' | 'qrSizeMm'; label: string; step: number; min: number; grid?: boolean }
const NUMS: Num[] = [
	{ key: 'pageWidthMm', label: 'Page width (mm)', step: 0.01, min: 0 },
	{ key: 'pageHeightMm', label: 'Page height (mm)', step: 0.01, min: 0 },
	{ key: 'columns', label: 'Columns', step: 1, min: 1, grid: true },
	{ key: 'rows', label: 'Rows', step: 1, min: 1, grid: true },
	{ key: 'labelWidthMm', label: 'Label width (mm)', step: 0.01, min: 0 },
	{ key: 'labelHeightMm', label: 'Label height (mm)', step: 0.01, min: 0 },
	{ key: 'marginTopMm', label: 'Top margin (mm)', step: 0.01, min: 0, grid: true },
	{ key: 'marginLeftMm', label: 'Left margin (mm)', step: 0.01, min: 0, grid: true },
	{ key: 'gapXMm', label: 'Column gap (mm)', step: 0.01, min: 0, grid: true },
	{ key: 'gapYMm', label: 'Row gap (mm)', step: 0.01, min: 0, grid: true },
	{ key: 'paddingMm', label: 'Padding (mm)', step: 0.01, min: 0 },
	{ key: 'qrSizeMm', label: 'QR size (mm, empty = largest)', step: 0.01, min: 0 },
];
// A roll is one label per page: no grid, margins or gaps to set.
const numbers = computed(() => NUMS.filter((n) => !(local.media === 'roll' && n.grid)));
const num = (key: Num['key']): number | string => {
	const v = local[key] as number | null;
	return v === null || Number.isNaN(v) ? '' : v;
};
function setNum(key: Num['key'], e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	(local as unknown as Record<string, unknown>)[key] = raw === '' ? (key === 'qrSizeMm' ? null : NaN) : Number(raw);
}
function setMedia(media: Media): void {
	local.media = media;
	if (media === 'roll') Object.assign(local, { columns: 1, rows: 1, marginTopMm: 0, marginLeftMm: 0, gapXMm: 0, gapYMm: 0 });
}

const { busy, error, create, update, remove } = useTemplateSave();
const isNew = computed(() => !local.id);
const canSave = computed(() => !props.problems.length && !busy.value);

async function save(): Promise<void> {
	const id = await update(draftOf(local), props.isAdmin, props.all);
	if (id) emit('saved', id);
}
async function saveAsNew(): Promise<void> {
	// An existing template saved as new needs its own name: the table's names are unique.
	const draft = isNew.value ? draftOf(local) : copyAsNew(local, local.name);
	const id = await create(draft, props.isAdmin, props.all);
	if (id) emit('saved', id);
}
const confirmDelete = ref(false);
async function del(): Promise<void> {
	if (!local.id) return;
	if (await remove(local.id)) emit('deleted');
	confirmDelete.value = false;
}
</script>

<template>
	<form class="editor" aria-label="Template editor" @submit.prevent="isNew ? saveAsNew() : save()">
		<div class="grid two">
			<label class="lf-field">Name<input v-model="local.name" type="text" maxlength="120" required /></label>
			<label class="lf-field">Note<input v-model="local.description" type="text" placeholder="The stock or printer this is for" /></label>
			<label class="lf-field">Media
				<select :value="local.media" @change="setMedia(($event.target as HTMLSelectElement).value as Media)">
					<option v-for="m in MEDIA" :key="m" :value="m">{{ MEDIA_LABEL[m] }}</option>
				</select>
			</label>
			<label class="lf-field">Arrangement
				<select v-model="local.arrangement">
					<option v-for="a in ARRANGEMENTS" :key="a" :value="a">{{ ARRANGEMENT_LABEL[a] }}</option>
				</select>
			</label>
		</div>

		<div class="grid nums">
			<label v-for="n in numbers" :key="n.key" class="lf-field">{{ local.media === 'roll' && n.key === 'pageWidthMm' ? 'Roll width (mm)' : local.media === 'roll' && n.key === 'pageHeightMm' ? 'Label length (mm)' : n.label }}
				<input type="number" :value="num(n.key)" :min="n.min" :step="n.step" inputmode="decimal" @input="setNum(n.key, $event)" />
			</label>
		</div>

		<FieldListEditor v-model:fields="local.fields" v-model:qr-fields="local.qrFields" />

		<label v-if="isAdmin" class="lf-check default"><input v-model="local.isDefault" type="checkbox" />Default template (selected first for everyone)</label>

		<ul v-if="problems.length" class="problems" role="alert">
			<li v-for="p in problems" :key="p">{{ p }}</li>
		</ul>
		<p v-if="error" class="d1-note bad" role="alert">{{ error }}</p>
		<p v-if="!isNew && !canEdit" class="d1-note">This template is not yours, so it can be saved as a new one but not changed or deleted.</p>

		<div class="lf-row actions">
			<button v-if="!isNew" type="submit" class="lf-btn pri" :disabled="!canEdit || !canSave">Save</button>
			<button type="button" class="lf-btn" :class="{ pri: isNew }" :disabled="!canSave" @click="saveAsNew">{{ isNew ? 'Create template' : 'Save as new' }}</button>
			<button type="button" class="lf-btn" @click="emit('close')">Close</button>
			<span class="spacer" />
			<template v-if="!isNew && canEdit">
				<button v-if="!confirmDelete" type="button" class="lf-btn bad" :disabled="busy" @click="confirmDelete = true">Delete</button>
				<template v-else>
					<span class="d1-note">Delete "{{ local.name }}"?</span>
					<button type="button" class="lf-btn bad" :disabled="busy" @click="del">Yes, delete</button>
					<button type="button" class="lf-btn" @click="confirmDelete = false">Keep</button>
				</template>
			</template>
		</div>
	</form>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: 14px; }
.grid { display: grid; gap: 10px; }
.two { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.nums { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
.default { align-self: flex-start; }
.problems { margin: 0; padding: 8px 12px 8px 28px; border-radius: 8px; font-size: var(--fs-sm, 12px); color: var(--d1-warn); background: color-mix(in srgb, var(--theme--warning) 12%, transparent); }
.actions { align-items: center; }
.spacer { flex: 1; }
</style>
