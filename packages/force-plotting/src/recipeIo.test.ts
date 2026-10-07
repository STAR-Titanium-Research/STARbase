import { describe, expect, it } from 'vitest';
import { DEFAULT_RECIPE, type Recipe } from './recipeChannels';
import {
	baselineAfterSave, exportRecipeJson, isModifiedSinceLoaded, parseRecipeJson, recipeFileName, validateRecipe,
} from './recipeIo';

const clone = (r: Recipe): Recipe => JSON.parse(JSON.stringify(r));

describe('recipe import / export', () => {
	it('round-trips an export', () => {
		const out = parseRecipeJson(exportRecipeJson({ name: 'Camp A', notes: 'n', recipe: DEFAULT_RECIPE }));
		expect(out).toMatchObject({ ok: true, name: 'Camp A', notes: 'n' });
		if (out.ok) expect(out.recipe).toEqual(DEFAULT_RECIPE);
	});
	it('accepts a bare recipe and takes its name', () => {
		const out = parseRecipeJson(JSON.stringify(DEFAULT_RECIPE));
		expect(out).toMatchObject({ ok: true, name: 'Default', notes: null });
	});
	it('refuses non-JSON, wrong version and non-objects', () => {
		expect(parseRecipeJson('{nope')).toEqual({ ok: false, error: 'not valid JSON' });
		expect(parseRecipeJson('[1]').ok).toBe(false);
		expect(parseRecipeJson(JSON.stringify({ d1_recipe: 9, recipe: DEFAULT_RECIPE }))).toMatchObject({ ok: false });
	});
	it('refuses unknown ops, bad params, duplicate ids and empty recipes', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[0].op = 'rm_rf';
		expect(validateRecipe(r)).toMatch(/unknown op/);
		const p = clone(DEFAULT_RECIPE);
		(p.steps[1].params as Record<string, unknown>).samples_per_rev = { x: 1 };
		expect(validateRecipe(p)).toMatch(/param/);
		const d = clone(DEFAULT_RECIPE);
		d.steps[1].id = 's1';
		expect(validateRecipe(d)).toMatch(/twice/);
		expect(validateRecipe({ ...DEFAULT_RECIPE, steps: [] })).toMatch(/no steps/);
	});
	it('refuses an unsatisfiable step order (reuses recipeProblems)', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[3].on = false; // radial_detrend off, getis_ord still needs resid_z
		expect(validateRecipe(r)).toMatch(/needs/);
	});
	it('makes a safe file name', () => {
		expect(recipeFileName(' Camp A/ 1 ')).toBe('Camp_A_1.d1recipe.json');
		expect(recipeFileName('///')).toBe('recipe.d1recipe.json');
	});
});

describe('import validation: version, param names and types, inputs', () => {
	it('refuses an unsupported recipe_version', () => {
		expect(validateRecipe({ ...clone(DEFAULT_RECIPE), recipe_version: 2 })).toMatch(/unsupported recipe_version 2/);
		expect(validateRecipe({ ...clone(DEFAULT_RECIPE), recipe_version: 0 })).toMatch(/unsupported recipe_version/);
		expect(parseRecipeJson(JSON.stringify({ ...clone(DEFAULT_RECIPE), recipe_version: 7 })).ok).toBe(false);
		expect(validateRecipe(clone(DEFAULT_RECIPE))).toBeNull();
	});
	it('refuses a param name the op does not have, but accepts the host-only scalars', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[4].params.kk = 30;
		expect(validateRecipe(r)).toMatch(/no param "kk"/);
		const ok = clone(DEFAULT_RECIPE);
		ok.steps[1].params.channel = 'fp';   // read by the host, not shown in the editor
		expect(validateRecipe(ok)).toBeNull();
	});
	it('refuses a param of the wrong kind or outside the options of a select', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[4].params.k = '30';
		expect(validateRecipe(r)).toMatch(/param "k" must be a number/);
		const n = clone(DEFAULT_RECIPE);
		n.steps[4].params.k = null;   // null is only for params that default to null (envelope fn_hz)
		expect(validateRecipe(n)).toMatch(/must be a number/);
		const s = clone(DEFAULT_RECIPE);
		s.steps[0].params.channel = 'fx';
		expect(validateRecipe(s)).toMatch(/must be one of fp, fc, ff/);
		const t = clone(DEFAULT_RECIPE);
		t.steps[0].params.channel = 3;
		expect(validateRecipe(t)).toMatch(/must be text/);
		expect(validateRecipe(clone(DEFAULT_RECIPE))).toBeNull();   // envelope's null fn_hz is fine
	});
	it('validates layer bindings in inputs', () => {
		const withInput = (inputs: unknown) => {
			const r = clone(DEFAULT_RECIPE);
			(r.steps[3] as { inputs?: unknown }).inputs = inputs;
			return validateRecipe(r);
		};
		expect(withInput({ mask: { layer: 'chuck', required: false } })).toBeNull();
		expect(withInput({ seeds: { layers: ['a', 'b'] } })).toBeNull();
		expect(withInput({ mask: 'chuck' })).toMatch(/input "mask" must be an object/);
		expect(withInput({ mask: {} })).toMatch(/either a layer name or a list/);
		expect(withInput({ mask: { layer: 'a', layers: ['b'] } })).toMatch(/either a layer name or a list/);
		expect(withInput({ mask: { layers: [1] } })).toMatch(/either a layer name or a list/);
		expect(withInput({ mask: { layer: 'a', required: 'yes' } })).toMatch(/required must be true or false/);
		expect(withInput({ mask: { layer: 'a', x: 1 } })).toMatch(/unknown keys/);
		expect(withInput([])).toMatch(/inputs must be an object/);
	});
	it('refuses layer inputs on a base-tier step, as the host does', () => {
		const r = clone(DEFAULT_RECIPE);
		(r.steps[1] as { inputs?: unknown }).inputs = { mask: { layer: 'chuck' } };
		expect(validateRecipe(r)).toMatch(/only derived steps can/);
	});
});

describe('isModifiedSinceLoaded', () => {
	it('is false with nothing loaded or an equivalent recipe', () => {
		expect(isModifiedSinceLoaded(DEFAULT_RECIPE, null)).toBe(false);
		const r = clone(DEFAULT_RECIPE);
		r.name = 'renamed';
		r.steps[0].id = 'zz';
		expect(isModifiedSinceLoaded(r, DEFAULT_RECIPE)).toBe(false);
	});
	it('is true when a param or enabled step changes', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[4].params.k = 31;
		expect(isModifiedSinceLoaded(r, DEFAULT_RECIPE)).toBe(true);
		const e = clone(DEFAULT_RECIPE);
		e.steps[6].on = true;
		expect(isModifiedSinceLoaded(e, DEFAULT_RECIPE)).toBe(true);
	});
});

describe('baselineAfterSave', () => {
	const working = clone(DEFAULT_RECIPE);
	const imported = clone(DEFAULT_RECIPE);
	imported.steps[4].params.k = 60;
	const prev = { name: 'Default', recipe: clone(DEFAULT_RECIPE) };

	it('saving the working recipe makes it the baseline', () => {
		const next = baselineAfterSave(prev, { name: 'Mine', recipe: working }, false);
		expect(next).toEqual({ name: 'Mine', recipe: working });
		expect(isModifiedSinceLoaded(working, next?.recipe ?? null)).toBe(false);
	});
	it('saving an imported recipe leaves the baseline alone, so nothing reads as modified', () => {
		const next = baselineAfterSave(prev, { name: 'Imported', recipe: imported }, true);
		expect(next).toBe(prev);
		expect(isModifiedSinceLoaded(working, next?.recipe ?? null)).toBe(false);
		// The old behaviour measured the untouched working recipe against the imported one.
		expect(isModifiedSinceLoaded(working, imported)).toBe(true);
	});
	it('with nothing loaded an import adds no baseline', () => {
		expect(baselineAfterSave(null, { name: 'Imported', recipe: imported }, true)).toBeNull();
	});
});
