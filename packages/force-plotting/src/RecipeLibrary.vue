<script setup lang="ts">
// The recipe library control in the RecipePanel footer: pick a saved recipe and Apply it onto
// the workbench's local recipe (the analyst then Bakes), or Save the current recipe under a
// name. CRUD is against diag_recipes via the items API; naming, renaming and deleting go through
// RecipeDialog (no window.prompt / confirm, which the packaged app cannot rely on). Recipes can
// be exported to / imported from JSON, and a badge says when the working recipe differs from the
// library recipe it was loaded from. Seeds are not part of a saved recipe — the analyst re-paints
// them per cut.
import { computed, ref } from 'vue';
import type { Recipe } from './recipeChannels';
import { saveRecipe, deleteRecipe, updateRecipe, type SavedRecipe } from './diagRecipes';
import { baselineAfterSave, exportRecipeJson, isModifiedSinceLoaded, parseRecipeJson, recipeFileName, type LoadedRecipe } from './recipeIo';
import { downloadText } from './csvExport';
import RecipeDialog from './RecipeDialog.vue';

const props = defineProps<{ library: SavedRecipe[]; currentRecipe: Recipe }>();
const emit = defineEmits<{
	(e: 'apply', r: Recipe): void;
	(e: 'saved'): void;
	(e: 'deleted'): void;
}>();

type Dlg =
	| { kind: 'save'; name: string; notes: string; recipe: Recipe; fromImport?: boolean }
	| { kind: 'rename'; id: string; name: string; notes: string }
	| { kind: 'delete'; id: string; name: string };

const sel = ref('');
const busy = ref(false);
const err = ref<string | null>(null);
const dlg = ref<Dlg | null>(null);
const dlgErr = ref<string | null>(null);
const fileEl = ref<HTMLInputElement | null>(null);
// The library recipe last applied or saved: what "modified" is measured against.
const loaded = ref<LoadedRecipe | null>(null);

const selected = computed(() => props.library.find((x) => x.recipe_id === sel.value) ?? null);
const modified = computed(() => isModifiedSinceLoaded(props.currentRecipe, loaded.value?.recipe ?? null));

function apply() {
	const r = selected.value;
	if (!r) return;
	loaded.value = { name: r.name, recipe: JSON.parse(JSON.stringify(r.recipe)) };
	emit('apply', JSON.parse(JSON.stringify(r.recipe)));
}
function openSave() {
	err.value = null; dlgErr.value = null;
	dlg.value = { kind: 'save', name: loaded.value?.name ?? '', notes: '', recipe: props.currentRecipe };
}
function openRename() {
	const r = selected.value;
	if (!r) return;
	dlgErr.value = null;
	dlg.value = { kind: 'rename', id: r.recipe_id, name: r.name, notes: r.notes ?? '' };
}
function openDelete() {
	const r = selected.value;
	if (!r) return;
	dlgErr.value = null;
	dlg.value = { kind: 'delete', id: r.recipe_id, name: r.name };
}
function closeDlg() { if (!busy.value) dlg.value = null; }

async function onConfirm(v: { name: string; notes: string }) {
	const d = dlg.value;
	if (!d) return;
	busy.value = true; dlgErr.value = null;
	try {
		if (d.kind === 'save') {
			const snap = JSON.parse(JSON.stringify(d.recipe)) as Recipe;
			const saved = await saveRecipe({ name: v.name, recipe: snap, notes: v.notes || undefined });
			loaded.value = baselineAfterSave(loaded.value, { name: v.name, recipe: snap }, !!d.fromImport);
			emit('saved');
			sel.value = saved?.recipe_id ?? sel.value;
		} else if (d.kind === 'rename') {
			await updateRecipe(d.id, { name: v.name, notes: v.notes || null });
			if (loaded.value && loaded.value.name === d.name) loaded.value.name = v.name;
			emit('saved');
		} else {
			await deleteRecipe(d.id);
			sel.value = '';
			emit('deleted');
		}
		dlg.value = null;
	} catch (e: unknown) {
		const x = e as { response?: { status?: number }; message?: string };
		dlgErr.value = x?.response?.status === 400 || x?.response?.status === 409
			? 'Could not save — is that name already taken?'
			: x?.message || 'The request failed.';
	} finally {
		busy.value = false;
	}
}

function download(name: string, text: string) {
	downloadText(recipeFileName(name), text, 'application/json');
}
function exportRecipe() {
	const r = selected.value;
	// With a saved recipe selected export that one; otherwise the working recipe.
	if (r) download(r.name, exportRecipeJson({ name: r.name, notes: r.notes, recipe: r.recipe }));
	else {
		const name = props.currentRecipe.name || 'recipe';
		download(name, exportRecipeJson({ name, recipe: props.currentRecipe }));
	}
}
async function onFile(e: Event) {
	const input = e.target as HTMLInputElement;
	const f = input.files?.[0];
	input.value = '';
	if (!f) return;
	err.value = null;
	const parsed = parseRecipeJson(await f.text());
	if (!parsed.ok) { err.value = `Import refused: ${parsed.error}.`; return; }
	// Hand it to the save dialog so the name can be fixed before it is stored.
	dlgErr.value = null;
	dlg.value = { kind: 'save', name: parsed.name, notes: parsed.notes ?? '', recipe: parsed.recipe, fromImport: true };
}
</script>

<template>
	<div class="recipe-library">
		<select v-model="sel" :disabled="busy" aria-label="Saved recipes">
			<option value="">— saved recipes —</option>
			<option v-for="r in library" :key="r.recipe_id" :value="r.recipe_id" :title="r.notes ?? ''">
				{{ r.name }}
			</option>
		</select>
		<button :disabled="!sel || busy" @click="apply">Apply</button>
		<button :disabled="busy" @click="openSave">Save as…</button>
		<button v-if="sel" :disabled="busy" title="Rename / edit notes" @click="openRename">Rename</button>
		<button v-if="sel" :disabled="busy" class="del" aria-label="Delete recipe" title="Delete recipe" @click="openDelete">✕</button>
		<button :disabled="busy" title="Download the selected (or current) recipe as JSON" @click="exportRecipe">Export</button>
		<button :disabled="busy" title="Load a recipe from a JSON file" @click="fileEl?.click()">Import</button>
		<input ref="fileEl" type="file" accept=".json,application/json" class="file" @change="onFile">
		<span
			v-if="modified"
			class="badge"
			:title="`The working recipe differs from “${loaded?.name}” as loaded. Save as… to keep the changes.`"
		>modified since loaded</span>
		<span v-else-if="loaded" class="loaded" title="Loaded from the library">{{ loaded.name }}</span>
		<span v-if="err" class="err" role="alert">{{ err }}</span>

		<RecipeDialog
			v-if="dlg"
			:mode="dlg.kind"
			:title="dlg.kind === 'save' ? 'Save recipe to the library' : dlg.kind === 'rename' ? 'Rename recipe' : 'Delete recipe'"
			:confirm-label="dlg.kind === 'save' ? 'Save' : dlg.kind === 'rename' ? 'Rename' : 'Delete'"
			:name="dlg.kind === 'delete' ? undefined : dlg.name"
			:notes="dlg.kind === 'delete' ? undefined : dlg.notes"
			:busy="busy"
			:error="dlgErr"
			@close="closeDlg"
			@confirm="onConfirm"
		>
			<p v-if="dlg.kind === 'delete'" class="del-msg">
				Delete recipe “{{ dlg.name }}”? Cuts already baked with it keep their result.
			</p>
		</RecipeDialog>
	</div>
</template>

<style scoped>
.recipe-library { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: var(--fs-xs, 11px); }
.recipe-library select { flex: 1; min-width: 90px; font-size: var(--fs-xs, 11px); padding: 3px 5px; background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 5px; }
.recipe-library button { font-size: var(--fs-xs, 11px); padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); cursor: pointer; }
.recipe-library button:disabled { opacity: 0.45; cursor: not-allowed; }
.recipe-library .del { color: var(--danger, #fca5a5); }
.recipe-library .file { display: none; }
.recipe-library .badge { padding: 1px 6px; border-radius: 9px; border: 1px solid var(--warn, #fbbf24); color: var(--warn, #fbbf24); }
.recipe-library .loaded { color: var(--text-dim, #94a3b8); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recipe-library .err { color: var(--danger, #fca5a5); width: 100%; }
</style>
