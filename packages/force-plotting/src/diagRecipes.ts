// The named diagnostics recipe library (diag_recipes table). Applying a saved recipe copies
// its document onto a cut's machining_force_analysis.diag_recipe — exactly the filter_chain /
// filter_profiles pattern. Seeds are per-cut and never travel; a saved recipe carries only
// the step list, params, and layer-name bindings.
import { useForceHost } from './host';
import type { Recipe } from './recipeChannels';

export interface SavedRecipe {
	recipe_id: string;
	name: string;
	recipe: Recipe;
	notes: string | null;
}

const FIELDS = ['recipe_id', 'name', 'recipe', 'notes'];

export async function fetchRecipeLibrary(): Promise<SavedRecipe[]> {
	const res = await useForceHost().api.get('/items/diag_recipes', {
		params: { fields: FIELDS, sort: 'name', limit: -1 },
	});
	return (res.data?.data ?? []) as SavedRecipe[];
}

export async function saveRecipe(p: { name: string; recipe: Recipe; notes?: string }): Promise<SavedRecipe> {
	const res = await useForceHost().api.post(
		'/items/diag_recipes',
		{ name: p.name, recipe: p.recipe, notes: p.notes ?? null },
		{ params: { fields: FIELDS } },
	);
	return res.data.data as SavedRecipe;
}

export async function deleteRecipe(recipeId: string): Promise<void> {
	await useForceHost().api.delete(`/items/diag_recipes/${recipeId}`);
}

export async function updateRecipe(
	recipeId: string,
	patch: { name?: string; notes?: string | null; recipe?: Recipe },
): Promise<SavedRecipe> {
	const res = await useForceHost().api.patch(`/items/diag_recipes/${recipeId}`, patch, { params: { fields: FIELDS } });
	return res.data.data as SavedRecipe;
}
