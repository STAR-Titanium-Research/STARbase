// JSON import / export of diagnostics recipes, and the "modified since loaded" check behind the
// library badge. Pure: no host, no DOM. Import validates the file shape and the recipe itself
// (known ops, typed params, satisfiable step order via recipeProblems) so a bad file is refused
// with a reason instead of being stored and failing later in the host bake.
import { safeFilePart } from './csvExport';
import { DEFAULT_RECIPE, recipeProblems, recipesEquivalent, STEP_META, type ParamSpec, type Recipe, type RecipeStep } from './recipeChannels';

export const RECIPE_FILE_TAG = 1;

export interface RecipeFile {
	d1_recipe: number;
	name: string;
	notes: string | null;
	recipe: Recipe;
}

export type ParsedRecipe =
	| { ok: true; name: string; notes: string | null; recipe: Recipe }
	| { ok: false; error: string };

export function exportRecipeJson(p: { name: string; notes?: string | null; recipe: Recipe }): string {
	const file: RecipeFile = { d1_recipe: RECIPE_FILE_TAG, name: p.name, notes: p.notes ?? null, recipe: p.recipe };
	return JSON.stringify(file, null, 2);
}

/** A filesystem-safe name for the downloaded file. */
export function recipeFileName(name: string): string {
	return `${safeFilePart(name) || 'recipe'}.d1recipe.json`;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The recipe schema version this app writes and understands (scripts/diag/recipe.py RECIPE_VERSION). */
export const SUPPORTED_RECIPE_VERSION = DEFAULT_RECIPE.recipe_version;

/** Scalar params the host reads that the editor does not surface (scripts/diag/ops.py), so a recipe
 *  that sets them is still valid. Anything else is a typo or a param the host would silently ignore. */
const HIDDEN_PARAMS: Record<string, ParamSpec[]> = {
	angular_resample: [{ key: 'channel', label: 'Channel', kind: 'select' }],
	tsa: [{ key: 'samples_per_rev', label: 'Samples / rev', kind: 'number' }],
	envelope: [
		{ key: 'channel', label: 'Channel', kind: 'select' },
		{ key: 'samples_per_rev', label: 'Samples / rev', kind: 'number' },
	],
};

/** Why this value does not suit the param, or null. Ranges are the editor's concern, not the file's. */
function paramProblem(spec: ParamSpec, v: number | string | null): string | null {
	if (spec.kind === 'number') {
		if (v === null) return spec.default === null ? null : 'must be a number';
		return typeof v === 'number' ? null : 'must be a number';
	}
	if (typeof v !== 'string') return 'must be text';
	if (spec.options && !spec.options.some((o) => o.value === v)) {
		return `must be one of ${spec.options.map((o) => o.value).join(', ')}`;
	}
	return null;
}

/** A layer binding: {layer: name} or {layers: [names]}, optionally {required: boolean}. */
function bindingProblem(b: unknown): string | null {
	if (!isObj(b)) return 'must be an object';
	if (Object.keys(b).some((k) => k !== 'layer' && k !== 'layers' && k !== 'required')) return 'has unknown keys';
	if (b.required !== undefined && typeof b.required !== 'boolean') return 'required must be true or false';
	const one = typeof b.layer === 'string' && !!b.layer;
	const many = Array.isArray(b.layers) && b.layers.length > 0 && b.layers.every((n) => typeof n === 'string' && !!n);
	if (one === many) return 'needs either a layer name or a list of layer names';
	return null;
}

function checkStep(s: unknown, i: number, seen: Set<string>): string | null {
	if (!isObj(s)) return `step ${i + 1} is not an object`;
	if (typeof s.id !== 'string' || !s.id) return `step ${i + 1} has no id`;
	if (seen.has(s.id)) return `step id "${s.id}" is used twice`;
	seen.add(s.id);
	if (typeof s.op !== 'string' || !STEP_META[s.op]) return `step ${i + 1} has an unknown op "${String(s.op)}"`;
	if (typeof s.on !== 'boolean') return `step "${s.id}" needs on: true or false`;
	if (!isObj(s.params)) return `step "${s.id}" has no params object`;
	const specs = [...STEP_META[s.op].params, ...(HIDDEN_PARAMS[s.op] ?? [])];
	for (const [k, v] of Object.entries(s.params)) {
		if (!(v === null || typeof v === 'number' || typeof v === 'string')) {
			return `step "${s.id}" param "${k}" must be a number, string or null`;
		}
		if (typeof v === 'number' && !Number.isFinite(v)) return `step "${s.id}" param "${k}" is not finite`;
		const spec = specs.find((p) => p.key === k);
		if (!spec) return `step "${s.id}" (${s.op}) has no param "${k}"`;
		const bad = paramProblem(spec, v);
		if (bad) return `step "${s.id}" param "${k}" ${bad}`;
	}
	if (s.inputs !== undefined) {
		if (!isObj(s.inputs)) return `step "${s.id}" inputs must be an object`;
		if (Object.keys(s.inputs).length && STEP_META[s.op].tier === 'base') {
			return `step "${s.id}" (${s.op}) cannot take layer inputs: only derived steps can`;
		}
		for (const [k, b] of Object.entries(s.inputs)) {
			const bad = bindingProblem(b);
			if (bad) return `step "${s.id}" input "${k}" ${bad}`;
		}
	}
	return null;
}

/** Validate a recipe document on its own (also used for a bare recipe in an import file). */
export function validateRecipe(r: unknown): string | null {
	if (!isObj(r)) return 'recipe is not an object';
	if (typeof r.recipe_version !== 'number') return 'recipe_version missing';
	if (r.recipe_version !== SUPPORTED_RECIPE_VERSION) {
		return `unsupported recipe_version ${r.recipe_version} (this app supports ${SUPPORTED_RECIPE_VERSION})`;
	}
	if (typeof r.name !== 'string') return 'recipe name missing';
	if (!Array.isArray(r.steps) || r.steps.length === 0) return 'recipe has no steps';
	const seen = new Set<string>();
	for (let i = 0; i < r.steps.length; i++) {
		const e = checkStep(r.steps[i], i, seen);
		if (e) return e;
	}
	const problems = recipeProblems(r as unknown as Recipe);
	if (problems.length) return problems[0].message;
	return null;
}

export function parseRecipeJson(text: string): ParsedRecipe {
	let doc: unknown;
	try { doc = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
	if (!isObj(doc)) return { ok: false, error: 'not a recipe file' };
	// Accept either the wrapped export or a bare recipe document.
	const wrapped = doc.d1_recipe !== undefined;
	if (wrapped && doc.d1_recipe !== RECIPE_FILE_TAG) {
		return { ok: false, error: `unsupported recipe file version ${String(doc.d1_recipe)}` };
	}
	const recipe = (wrapped ? doc.recipe : doc) as unknown;
	const err = validateRecipe(recipe);
	if (err) return { ok: false, error: err };
	const r = recipe as Recipe;
	const name = wrapped && typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : r.name;
	const notes = wrapped && typeof doc.notes === 'string' && doc.notes ? doc.notes : null;
	const steps: RecipeStep[] = r.steps.map((s) => ({
		id: s.id, op: s.op, on: s.on, params: { ...s.params }, ...(s.inputs ? { inputs: { ...s.inputs } } : {}),
	}));
	return { ok: true, name, notes, recipe: { recipe_version: r.recipe_version, name: r.name, steps } };
}

/** "Modified since loaded": the working recipe no longer matches the library recipe it was
 *  loaded from (or last saved as). False when nothing has been loaded. */
export function isModifiedSinceLoaded(current: Recipe, loaded: Recipe | null): boolean {
	if (!loaded) return false;
	return !recipesEquivalent(current, loaded);
}

/** A library recipe the workbench's recipe was loaded from or last saved as. */
export interface LoadedRecipe { name: string; recipe: Recipe }

/** The "modified since loaded" baseline after saving to the library. Saving the working recipe makes
 *  it the baseline. Saving an IMPORTED recipe stores it but does not put it on the workbench, so the
 *  baseline stays what it was: measuring the unchanged working recipe against the imported one
 *  would show "modified" with nothing edited. */
export function baselineAfterSave(prev: LoadedRecipe | null, saved: LoadedRecipe, fromImport: boolean): LoadedRecipe | null {
	return fromImport ? prev : saved;
}
