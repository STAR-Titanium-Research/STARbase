// The client-side view of a diagnostics recipe: the step model, the built-in default (kept in
// lockstep with scripts/diag/recipe.py's DEFAULT_RECIPE), the per-op parameter schema the
// RecipePanel renders, and the derivation of "which channels does this recipe produce" that
// populates the Spatial panel's channel selector.
//
// The client never executes a recipe — it edits the object and posts it to diag-service. The
// canonical hash lives in Python; here `recipesEquivalent` is a structural comparison used
// only for the advisory "bake stale" indicator.
import type { ChannelKey } from './selection';

export interface RecipeStep {
	id: string;
	op: string;
	on: boolean;
	params: Record<string, number | string | null>;
	inputs?: Record<string, unknown>;
}

export interface Recipe {
	recipe_version: number;
	name: string;
	steps: RecipeStep[];
}

/** Verbatim transcription of scripts/diag/recipe.py::DEFAULT_RECIPE. A test pins the op list,
 *  ids and envelope-off state so drift from Python is caught. */
export const DEFAULT_RECIPE: Recipe = {
	recipe_version: 1,
	name: 'Default',
	steps: [
		{ id: 's1', op: 'frame_transform', on: true, params: { channel: 'fp', mount_deg: 0.0 } },
		{ id: 's2', op: 'angular_resample', on: true, params: { samples_per_rev: 256 } },
		{ id: 's3', op: 'tsa', on: true, params: {} },
		{ id: 's4', op: 'radial_detrend', on: true, params: { n_bins: 200, min_per_bin: 8 } },
		{ id: 's5', op: 'getis_ord', on: true, params: { k: 30, alpha: 0.05 } },
		{ id: 's6', op: 'hdbscan', on: true, params: { grid_target: 20000, min_cluster_size: 10 } },
		{ id: 's7', op: 'envelope', on: false, params: { bandwidth_frac: 0.2, fn_hz: null } },
	],
};

export interface ParamSpec {
	key: string;
	label: string;
	kind: 'number' | 'select';
	min?: number;
	max?: number;
	step?: number;
	options?: { value: string; label: string }[];
	/** Value a newly-added step starts with. Falls back to `min` (number) or the first
	 *  option (select) when absent -- which is wrong for any param whose sensible default
	 *  isn't its minimum (e.g. grow_segmentation.k defaults to 15, not its min of 3), so
	 *  every param below sets this explicitly. */
	default?: number | string | null;
}

// Mirrors scripts/diag/registry.py::CATEGORIES. What kind of thing a step does, for the step
// PICKER only -- the pipeline itself stays a flat ordered list, because step order is
// semantic (radial_detrend must run before getis_ord) and grouping the list would hide that.
export type StepCategory = 'transform' | 'residual' | 'interpolation' | 'statistics' | 'segmentation';

export const CATEGORY_LABELS: Record<StepCategory, string> = {
	transform: 'Transform',
	residual: 'Residual',
	interpolation: 'Interpolation',
	statistics: 'Statistics',
	segmentation: 'Segmentation',
};

// Picker display order -- roughly pipeline order, so a step's own category is never far from
// where it would sit in a freshly-built recipe.
export const CATEGORY_ORDER: StepCategory[] = [
	'transform', 'residual', 'interpolation', 'statistics', 'segmentation',
];

export interface StepMeta {
	label: string;
	tier: 'base' | 'derived';
	category: StepCategory;
	/** snake_case columns this step produces (registry `produces`). */
	produces: string[];
	params: ParamSpec[];
}

// Mirrors scripts/diag/ops.py's @step registrations. Only the tunable params are surfaced.
export const STEP_META: Record<string, StepMeta> = {
	frame_transform: {
		label: 'Frame transform', tier: 'base', category: 'transform', produces: ['fc', 'ff', 'fp'],
		params: [{
			key: 'channel', label: 'Channel', kind: 'select', default: 'fp',
			options: [
				{ value: 'fp', label: 'Fp (dyno Z)' },
				{ value: 'fc', label: 'Fc (cutting)' },
				{ value: 'ff', label: 'Ff (feed)' },
			],
		}, { key: 'mount_deg', label: 'Mount °', kind: 'number', min: -180, max: 180, step: 1, default: 0 }],
	},
	angular_resample: {
		label: 'Angular resample', tier: 'base', category: 'transform', produces: ['t', 'rev', 'x', 'y', 'sig'],
		params: [{ key: 'samples_per_rev', label: 'Samples / rev', kind: 'number', min: 64, max: 2048, step: 64, default: 256 }],
	},
	tsa: { label: 'TSA residual', tier: 'derived', category: 'residual', produces: ['tsa_resid'], params: [] },
	radial_detrend: {
		label: 'Radial detrend', tier: 'derived', category: 'residual', produces: ['resid_z'],
		params: [
			{ key: 'n_bins', label: 'Radial bins', kind: 'number', min: 20, max: 1000, step: 10, default: 200 },
			{ key: 'min_per_bin', label: 'Min / bin', kind: 'number', min: 2, max: 100, step: 1, default: 8 },
		],
	},
	getis_ord: {
		label: 'Getis-Ord Gi*', tier: 'derived', category: 'statistics', produces: ['gi_star', 'gi_sig'],
		params: [
			{ key: 'k', label: 'Neighbours k', kind: 'number', min: 5, max: 200, step: 1, default: 30 },
			{ key: 'alpha', label: 'FDR α', kind: 'number', min: 0.001, max: 0.2, step: 0.005, default: 0.05 },
		],
	},
	hdbscan: {
		label: 'HDBSCAN clusters', tier: 'derived', category: 'segmentation', produces: ['cluster_id', 'glosh'],
		params: [
			{ key: 'grid_target', label: 'Grid target', kind: 'number', min: 2000, max: 60000, step: 1000, default: 20000 },
			{ key: 'min_cluster_size', label: 'Min cluster', kind: 'number', min: 3, max: 200, step: 1, default: 10 },
		],
	},
	envelope: {
		label: 'Envelope band', tier: 'base', category: 'residual', produces: ['env_band'],
		params: [
			{ key: 'fn_hz', label: 'Dyno fₙ (Hz)', kind: 'number', min: 0, max: 20000, step: 50, default: null },
			{ key: 'bandwidth_frac', label: 'Band width frac', kind: 'number', min: 0.05, max: 0.5, step: 0.05, default: 0.2 },
		],
	},
	grow_segmentation: {
		label: 'Seeded segmentation', tier: 'derived', category: 'segmentation', produces: ['segment_id'],
		params: [
			{ key: 'k', label: 'Neighbours k', kind: 'number', min: 3, max: 100, step: 1, default: 15 },
			{ key: 'alpha', label: 'Clamping α', kind: 'number', min: 0.01, max: 0.9, step: 0.05, default: 0.2 },
			{ key: 'attr_weight', label: 'Attr weight', kind: 'number', min: 0.1, max: 10, step: 0.1, default: 1 },
		],
	},
	invert: {
		label: 'Invert', tier: 'derived', category: 'transform', produces: ['inverted'],
		params: [
			{
				key: 'source', label: 'Source channel', kind: 'select', default: 'resid_z',
				options: [
					{ value: 'resid_z', label: 'resid_z' },
					{ value: 'gi_star', label: 'gi_star' },
					{ value: 'glosh', label: 'glosh' },
					{ value: 'tsa_resid', label: 'tsa_resid' },
					{ value: 'env_band', label: 'env_band' },
				],
			},
			{
				key: 'mode', label: 'Mode', kind: 'select', default: 'complement',
				options: [
					{ value: 'complement', label: 'Complement (max − v)' },
					{ value: 'reciprocal', label: 'Reciprocal (1 / |v|)' },
				],
			},
			{ key: 'epsilon', label: 'Epsilon (reciprocal)', kind: 'number', min: 1e-9, max: 1, step: 1e-6, default: 1e-6 },
		],
	},
	griddify: {
		label: 'Griddify', tier: 'derived', category: 'interpolation', produces: ['grid_fill', 'grid_support'],
		params: [
			{ key: 'resolution_mm', label: 'Resolution (mm)', kind: 'number', min: 0.05, max: 5, step: 0.05, default: 0.25 },
			{
				key: 'method', label: 'Method', kind: 'select', default: 'linear',
				options: [
					{ value: 'linear', label: 'Linear' },
					{ value: 'nearest', label: 'Nearest' },
				],
			},
			{ key: 'max_fill_mm', label: 'Max fill distance (mm)', kind: 'number', min: 0.1, max: 20, step: 0.1, default: 1.0 },
		],
	},
	gmm_segmentation: {
		label: 'GMM segmentation', tier: 'derived', category: 'segmentation', produces: ['gmm_id', 'gmm_prob'],
		params: [
			{ key: 'n_components', label: 'Components', kind: 'number', min: 2, max: 20, step: 1, default: 4 },
			{
				key: 'covariance_type', label: 'Covariance', kind: 'select', default: 'full',
				options: [
					{ value: 'full', label: 'Full' },
					{ value: 'tied', label: 'Tied' },
					{ value: 'diag', label: 'Diagonal' },
					{ value: 'spherical', label: 'Spherical' },
				],
			},
			{ key: 'attr_weight', label: 'Attr weight', kind: 'number', min: 0.1, max: 10, step: 0.1, default: 1 },
			{ key: 'random_state', label: 'Random seed', kind: 'number', min: 0, max: 9999, step: 1, default: 0 },
			{ key: 'grid_target', label: 'Grid target', kind: 'number', min: 2000, max: 60000, step: 1000, default: 20000 },
		],
	},
};

// snake_case produced column -> the selectable ChannelKey it corresponds to. Only the
// per-point analysis channels; fc/ff/fp/sig are intermediates with no channel.
const PRODUCED_TO_CHANNEL: Record<string, ChannelKey> = {
	tsa_resid: 'tsaResid', resid_z: 'residZ', gi_star: 'giStar', gi_sig: 'giSig',
	cluster_id: 'clusterId', glosh: 'glosh', env_band: 'envBand', segment_id: 'segmentId',
	inverted: 'inverted', grid_fill: 'gridFill', grid_support: 'gridSupport',
	gmm_id: 'gmmId', gmm_prob: 'gmmProb',
};

const ALL_CHANNELS: { key: ChannelKey; label: string }[] = [
	{ key: 'residZ', label: 'resid_z — anomaly z-score' },
	{ key: 'giStar', label: 'gi_star — hotspot statistic' },
	{ key: 'giSig', label: 'gi_sig — significant hotspots' },
	{ key: 'clusterId', label: 'cluster_id — HDBSCAN clusters' },
	{ key: 'glosh', label: 'glosh — outlier score' },
	{ key: 'tsaResid', label: 'tsa_resid — TSA residual' },
	{ key: 'envBand', label: 'env_band — resonance envelope' },
	{ key: 'inverted', label: 'inverted — value-inverted channel' },
	{ key: 'gridFill', label: 'grid_fill — griddified value' },
	{ key: 'gridSupport', label: 'grid_support — interpolation confidence' },
	{ key: 'gmmId', label: 'gmm_id — GMM segment' },
	{ key: 'gmmProb', label: 'gmm_prob — GMM confidence' },
	{ key: 'segmentId', label: 'segment_id — seeded regions' },
];

export interface ChannelOption {
	key: ChannelKey;
	label: string;
	/** true when an ENABLED step in this recipe produces the channel. */
	produced: boolean;
}

/** The channel a "revert to this step" click should switch the hero Spatial view to -- the
 *  first of the step's produced columns that has a selectable channel (a step like
 *  frame_transform or angular_resample produces only intermediates with no channel of their
 *  own, so this is null for those; the caller just leaves whatever channel was already
 *  showing). */
export function primaryChannelForOp(op: string): ChannelKey | null {
	for (const c of STEP_META[op]?.produces ?? []) {
		const ch = PRODUCED_TO_CHANNEL[c];
		if (ch) return ch;
	}
	return null;
}

/** Mirror of plugins/diag-service/app/main.py::_first_derived_index -- the step /preview
 *  resumes from (base.d1an already has everything before it baked in; a base-tier step
 *  AFTER this point, e.g. envelope, gets switched off for the preview by
 *  _disable_unpreviewable instead of running). -1 when the recipe has no derived step. */
export function firstDerivedIndex(recipe: Recipe): number {
	return recipe.steps.findIndex((s) => STEP_META[s.op]?.tier === 'derived');
}

/** Whether "revert to this step" (Phase H slice 3 -- click a step card to view the pipeline's
 *  state as of it) can show a REAL answer for the step at `index`. A step before
 *  firstDerivedIndex is base-tier and /preview never re-runs base-tier steps at all -- asking
 *  for stop_after less than that resumes at from_step, sees stop_after already behind it, and
 *  runs NOTHING: every derived column comes back at its neutral fill, which reads as "the
 *  workbench broke," not "here is step 1's state." */
export function stepIsRevertable(recipe: Recipe, index: number): boolean {
	const first = firstDerivedIndex(recipe);
	return first !== -1 && index >= first;
}

/** The Spatial selector's option list, each flagged whether the current recipe produces it. */
export function recipeChannels(recipe: Recipe): ChannelOption[] {
	const producedCols = new Set<string>();
	for (const s of recipe.steps) {
		if (!s.on) continue;
		for (const c of STEP_META[s.op]?.produces ?? []) producedCols.add(c);
	}
	const producedChannels = new Set<ChannelKey>();
	for (const c of producedCols) {
		const ch = PRODUCED_TO_CHANNEL[c];
		if (ch) producedChannels.add(ch);
	}
	return ALL_CHANNELS.map((c) => ({ ...c, produced: producedChannels.has(c.key) }));
}

function canonicalStep(s: RecipeStep): string {
	const params = Object.fromEntries(Object.entries(s.params).sort(([a], [b]) => a.localeCompare(b)));
	const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify({ op: s.op, params, inputs });
}

/** Structural equivalence of two recipes for the "bake stale" chip: same ENABLED steps in
 *  order, same op + params. Mirrors the intent of scripts/diag/recipe.py::_canonical (id and
 *  disabled steps do not count) without trying to reproduce Python's exact hash bytes. */
export function recipesEquivalent(a: Recipe, b: Recipe): boolean {
	const ea = a.steps.filter((s) => s.on).map(canonicalStep);
	const eb = b.steps.filter((s) => s.on).map(canonicalStep);
	return ea.length === eb.length && ea.every((s, i) => s === eb[i]);
}

// --- recipe validation (mirror of scripts/diag/registry.py::validate_recipe) ----------------
//
// The service refuses an unsatisfiable recipe with a 422 whose body is a Python error string.
// Before this existed, toggling `radial_detrend` off left the workbench firing a doomed
// preview on every subsequent keystroke and showing `step 's5' (getis_ord) requires
// ['resid_z'], which no earlier enabled step produces` as though the analyst had broken
// something unrecoverable. Checking client-side lets the panel mark the offending step, say
// which earlier step to re-enable, and not send the request at all.

/** Verbatim from scripts/diag/registry.py::SEED_COLUMNS. */
const SEED_COLUMNS = ['t_raw', 'fx', 'fy', 'fz', 'rpm', 'revs', 'x_raw', 'y_raw'];

/** snake_case column -> the label of the step that produces it, for a human-readable fix. */
const PRODUCER_OF: Record<string, string> = (() => {
	const out: Record<string, string> = {};
	for (const meta of Object.values(STEP_META)) {
		for (const c of meta.produces) out[c] = meta.label;
	}
	return out;
})();

// Mirrors each op's registry `requires`. Kept beside STEP_META's `produces` so the two halves
// of a step's contract live together; a test pins them against the Python registry.
const STEP_REQUIRES: Record<string, string[]> = {
	frame_transform: ['fx', 'fy', 'fz'],
	angular_resample: ['revs', 't_raw', 'x_raw', 'y_raw', 'fc', 'ff', 'fp'],
	tsa: ['sig', 'rev'],
	radial_detrend: ['tsa_resid', 'x', 'y'],
	getis_ord: ['x', 'y', 'resid_z'],
	hdbscan: ['x', 'y', 'resid_z'],
	envelope: ['fc', 'ff', 'fp', 'revs', 't_raw', 'tsa_resid'],
	grow_segmentation: ['x', 'y', 'resid_z'],
	// Empty on purpose: invert's real dependency is params.source, chosen at recipe-edit
	// time, which the static requires/produces graph cannot express. recipeProblems() below
	// checks it directly instead.
	invert: [],
	griddify: ['x', 'y', 'resid_z'],
	gmm_segmentation: ['x', 'y', 'resid_z'],
};

export interface RecipeProblem {
	/** id of the step that cannot run. */
	stepId: string;
	/** columns it needs that nothing enabled before it produces. */
	missing: string[];
	/** One sentence naming the fix, in step labels rather than column names. */
	message: string;
}

/**
 * Every enabled step whose inputs are not satisfied by an earlier enabled step, in order.
 * An empty array means the recipe will run.
 */
export function recipeProblems(recipe: Recipe): RecipeProblem[] {
	const have = new Set<string>(SEED_COLUMNS);
	const problems: RecipeProblem[] = [];
	for (const s of recipe.steps) {
		if (!s.on) continue;
		const missing = (STEP_REQUIRES[s.op] ?? []).filter((c) => !have.has(c));
		if (missing.length) {
			const fixes = [...new Set(missing.map((c) => PRODUCER_OF[c]).filter(Boolean))];
			const label = STEP_META[s.op]?.label ?? s.op;
			problems.push({
				stepId: s.id,
				missing,
				message: fixes.length
					? `${label} needs ${fixes.join(' and ')} — re-enable ${fixes.length > 1 ? 'those steps' : 'that step'}, or switch ${label} off.`
					: `${label} needs ${missing.join(', ')}, which nothing before it produces.`,
			});
			continue;   // do not pretend this step produced anything
		}
		// invert's dependency is params.source, a runtime choice STEP_REQUIRES cannot express
		// (see the comment on STEP_REQUIRES.invert and scripts/diag/ops.py::_op_invert, which
		// raises the same check server-side). Checked here so a stranded invert is caught
		// before the request, exactly like every step above.
		if (s.op === 'invert') {
			const source = String(s.params.source ?? 'resid_z');
			if (!have.has(source)) {
				const fix = PRODUCER_OF[source];
				const label = STEP_META[s.op]?.label ?? s.op;
				problems.push({
					stepId: s.id,
					missing: [source],
					message: fix
						? `${label} needs ${fix} — re-enable that step, or choose a different source.`
						: `${label} needs ${source}, which nothing before it produces.`,
				});
				continue;
			}
		}
		for (const c of STEP_META[s.op]?.produces ?? []) have.add(c);
	}
	return problems;
}
