<script setup lang="ts">
// The recipe library control in the RecipePanel footer: pick a saved recipe and Apply it onto
// the workbench's local recipe (the analyst then Bakes), or Save the current recipe under a
// name. CRUD is against diag_recipes via the items API. Seeds are not part of a saved recipe
// — the analyst re-paints them per cut.
import { ref } from 'vue';
import type { Recipe } from './recipeChannels';
import { saveRecipe, deleteRecipe, type SavedRecipe } from './diagRecipes';

const props = defineProps<{ library: SavedRecipe[]; currentRecipe: Recipe }>();
const emit = defineEmits<{
	(e: 'apply', r: Recipe): void;
	(e: 'saved'): void;
	(e: 'deleted'): void;
}>();

const sel = ref('');
const busy = ref(false);
const err = ref<string | null>(null);

function apply() {
	const r = props.library.find((x) => x.recipe_id === sel.value);
	if (r) emit('apply', JSON.parse(JSON.stringify(r.recipe)));
}
async function saveAs() {
	const name = window.prompt('Save recipe to the library as:');
	if (!name) return;
	busy.value = true;
	err.value = null;
	try {
		await saveRecipe({ name, recipe: props.currentRecipe });
		emit('saved');
	} catch (e: unknown) {
		err.value = (e as { message?: string })?.message || 'save failed (name taken?)';
	} finally {
		busy.value = false;
	}
}
async function removeSel() {
	const r = props.library.find((x) => x.recipe_id === sel.value);
	if (!r || !window.confirm(`Delete recipe "${r.name}"?`)) return;
	busy.value = true;
	try {
		await deleteRecipe(r.recipe_id);
		sel.value = '';
		emit('deleted');
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="recipe-library">
		<select v-model="sel" :disabled="busy">
			<option value="">— saved recipes —</option>
			<option v-for="r in library" :key="r.recipe_id" :value="r.recipe_id" :title="r.notes ?? ''">
				{{ r.name }}
			</option>
		</select>
		<button :disabled="!sel || busy" @click="apply">Apply</button>
		<button :disabled="busy" @click="saveAs">Save as…</button>
		<button v-if="sel" :disabled="busy" class="del" @click="removeSel">✕</button>
		<span v-if="err" class="err">{{ err }}</span>
	</div>
</template>

<style scoped>
.recipe-library { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: var(--fs-xs, 11px); }
.recipe-library select { flex: 1; min-width: 90px; font-size: var(--fs-xs, 11px); padding: 3px 5px; background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 5px; }
.recipe-library button { font-size: var(--fs-xs, 11px); padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); cursor: pointer; }
.recipe-library button:disabled { opacity: 0.45; cursor: not-allowed; }
.recipe-library .del { color: var(--danger, #fca5a5); }
.recipe-library .err { color: var(--danger, #fca5a5); width: 100%; }
</style>
