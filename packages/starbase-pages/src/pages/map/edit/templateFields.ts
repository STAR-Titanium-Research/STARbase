// Which fields of an operation or a test a template may keep (redesign R7): an ALLOW-LIST, decided from the form the person fills in, with a
// deny-list behind it for the columns that are known to be wrong anyway. A template is the SETUP of the work (the method or test type, the
// machine, tool, cutting edge and operator, and the process settings of the form's settings groups), never what one run produced or points at
// (results, status, codes, files, ids of other records, owners, imported-run identity).
//
// Why an allow-list: the columns of these two tables keep growing (every new test type adds its parameters and results), and a deny-list
// only knew the columns of the day. The field definitions the generated form already loads say which group each field is in, so a new settings
// field is kept without a change here and a new result field is not.
//
// Pure, no Vue: the field definitions are the raw `/fields/<collection>` rows (`meta.group`, `meta.readonly`, `meta.special`, `meta.interface`).

import { isReserved, type DraftKind, type FieldDef as DirectusField } from '@d1/ui';

/** The references that ARE the setup: the method or test type and what it is carried out with (machine, tool, edge, operator). */
export const SETUP_REFERENCES: readonly string[] = ['method_id', 'process_category', 'machining_operation_subtype', 'test_type', 'test_category', 'equipment_id', 'tool_id', 'insert_edge_id', 'operator_person_id'];

/** The groups of the form that hold process settings: cutting, tooling, heat treatment, deformation, additive, Conform, the FAST machine settings, and a test type's parameters (`*_params`). */
const SETTINGS_GROUP = /^(grp_cutting|grp_tooling|grp_heat_treatment|grp_deformation|grp_additive|grp_conform|sintering_machine_group|grp_[a-z_]*_params|grp_(optical_microscopy|sem|xrd|tem|alicona|clemx|dct|ct_scan|hardness|charpy|tensile|compression|tribology|fatigue|creep|dma))$/;

/** The groups that hold what a run produced or who, when and where it was: results, QA readings, capture flags, legacy and imported data, notes and files, links, the sample prep recipe. */
const NOT_SETTINGS_GROUP = /(_results?$|^grp_legacy$|^grp_capture$|^grp_notes_files$|^grp_related$|^grp_what$|^grp_who_where$|^grp_sample_prep$|^sintering_qa_group$)/;

/**
 * The second line of defence: columns that are never in a template, whatever group they are in (an old form, a field with no group).
 * Run identity and imported-run data (the FAST run number is unique with its machine: a second operation made from a template would be
 * refused), results and pipeline status, files, codes, owners, and per-run readings.
 */
const NEVER = new Set([
	// the run's identity and where it was imported from
	'sintering_run_number', 'sintering_batch_number', 'sintering_mass_grams', 'sintering_material_type_note', 'source_system', 'source_run_uid', 'source_recipe_id', 'fast_recipe_id',
	'recorded_metadata', 'machining_experiment_sheet_url', 'machining_chips_ref_code', 'machining_chips_collected', 'machining_force_captured', 'machining_tacho_used',
	// files and where they are
	'gcode_file', 'nc_program_file_uri', 'nc_program_text', 'force_file_id', 'file_storage_pointer', 'file_size_gb', 'data_file_uri', 'data_file_size_gb', 'plot_uris', 'capture_software', 'capture_frequency_khz',
	// a Conform run's own readings and results (the feedstock and setpoints are the recipe; what went in and came out is this run's)
	'conform_feed_mass_g', 'conform_extrusion_length_mm', 'conform_extrusion_mass_g', 'conform_yield_pct', 'conform_flash_mass_g',
	// results and pipeline status
	'summary_stats', 'status',
	// who and which sample
	'owner', 'operator', 'owner_person_id', 'owner_team_id', 'created_by', 'sample_id', 'output_sample_id', 'batch_id', 'project_id', 'campaign_id', 'material_id',
	// codes and the dates of one run
	'pass_code', 'test_code', 'short_id', 'code_sort', 'operation_date', 'session_date', 'planned_date', 'operation_sequence', 'outcome_notes', 'notes',
	'restricted', 'work_state', 'done_by_person_id', 'done_at', 'operator_name',
]);
const NEVER_PATTERN = /^(test_code_|machining_legacy_|data_file|source_)|(_notable_features|_uri|_url|_recipe_id|_run_number|_ref_code)$/;

/** True for a column the second line of defence always refuses. */
export const neverInATemplate = (field: string): boolean => NEVER.has(field) || NEVER_PATTERN.test(field);

const specialOf = (d: DirectusField): string[] => {
	const s = d.meta?.special;
	return Array.isArray(s) ? s.map(String) : typeof s === 'string' ? s.split(',').map((x) => x.trim()) : [];
};

/** The names of a field's group and of the groups that group is inside, nearest first. */
function groupChain(field: string, byName: ReadonlyMap<string, DirectusField>): string[] {
	const out: string[] = [];
	let g = byName.get(field)?.meta?.group as string | null | undefined;
	while (g && !out.includes(g)) {
		out.push(g);
		g = byName.get(g)?.meta?.group as string | null | undefined;
	}
	return out;
}

/** Whether `field` is a process setting by the form: in a settings group (and in no results group), not read-only, not a pointer to a file or to another record. */
export function isSetting(field: string, byName: ReadonlyMap<string, DirectusField>): boolean {
	const def = byName.get(field);
	if (!def) return false;
	if (def.meta?.readonly === true || def.type === 'alias') return false;
	const special = specialOf(def);
	if (special.some((s) => ['file', 'files', 'm2m', 'o2m', 'm2a'].includes(s)) || def.meta?.interface === 'file') return false;
	const chain = groupChain(field, byName);
	if (chain.some((g) => NOT_SETTINGS_GROUP.test(g))) return false;
	// A link to another record is only ever the setup's own references (above), never a recipe, a run or a file.
	if (special.includes('m2o') || String(def.meta?.interface ?? '').includes('m2o')) return false;
	return chain.some((g) => SETTINGS_GROUP.test(g));
}

/**
 * What a template of `kind` may keep out of `values`: the setup references and the settings of the form, never anything the deny-list names and
 * never what the server refuses in a draft. Without field definitions (they could not be read) only the deny-list applies, so nothing known to be
 * wrong is kept, and nothing else is lost silently.
 */
export function allowedForTemplate(kind: DraftKind, values: Record<string, unknown>, defs: readonly DirectusField[]): Record<string, unknown> {
	const byName = new Map(defs.map((d) => [d.field, d] as const));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined || isReserved(kind, k) || neverInATemplate(k)) continue;
		if (defs.length && !SETUP_REFERENCES.includes(k) && !isSetting(k, byName)) continue;
		out[k] = v;
	}
	return out;
}
