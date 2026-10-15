// Which fields STARbase's form shows for one draft item (spec E15, E17), and what the card shows inline as key settings. Pure,
// no Vue: DraftItemForm.vue is thin over this.

import type { DraftItem, FieldDef, FormField } from '@d1/ui';
import { KEY_SETTING_FIELDS } from '../model/formSlots';

/** Fields the draft fills in by itself (wires, the work state, who and when it was done, a batch, the sequence); never asked for. */
export const SET_BY_THE_DRAFT: ReadonlySet<string> = new Set([
	'sample_id', 'output_sample_id', 'operation_id', 'session_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'operation_sequence',
]);

/** Codes the database numbers at Create: not asked for on a new record, shown read-only on one that exists. */
export const CODE_FIELDS: ReadonlySet<string> = new Set(['sample_code', 'pass_code', 'test_code']);

/** A new sample's status is the draft's too (planned while the operation that makes it is planned). */
const NEW_SAMPLE_ONLY = new Set(['current_status']);

/**
 * The field changes the form applies on top of the generated model: these have a custom Data Studio interface that only
 * means something inside Data Studio, so the form shows the value as plain read-only text instead of "Open in Data Studio".
 * `process_category` follows the method (a server trigger sets it); the codes are numbered at Create (stream B's notes).
 */
export const TEXT_OVERRIDES: Record<string, Partial<FormField>> = {
	process_category: { kind: 'text', readonly: true, required: false, interfaceName: 'input' },
	sample_code: { kind: 'text', readonly: true, required: false, interfaceName: 'input' },
	pass_code: { kind: 'text', readonly: true, required: false, interfaceName: 'input' },
	test_code: { kind: 'text', readonly: true, required: false, interfaceName: 'input' },
};

const COLLECTION: Record<DraftItem['kind'], string> = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' };
/** The Directus collection a draft item's record lives in. */
export const collectionFor = (item: DraftItem): string => COLLECTION[item.kind];

export interface FormDefsOptions {
	/** Only these fields (the card's key settings), in the form's own order. */
	keyFields?: readonly string[];
	compact?: boolean;
}

/**
 * The definitions to draw for `item`: without what the draft sets itself (and, on a new record, the codes), and for a
 * compact form only `keyFields`. A field group whose fields are all left out draws nothing (FieldForm hides empty groups).
 */
export function formDefsFor(defs: readonly unknown[], item: DraftItem, opts: FormDefsOptions = {}): FieldDef[] {
	const keep = opts.compact ? new Set(opts.keyFields ?? []) : null;
	const isNew = !item.existing;
	const out: FieldDef[] = [];
	for (const d of defs) {
		const def = d as FieldDef | null;
		if (!def || typeof def.field !== 'string') continue;
		const name = def.field;
		if (SET_BY_THE_DRAFT.has(name)) continue;
		if (isNew && (CODE_FIELDS.has(name) || (item.kind === 'sample' && NEW_SAMPLE_ONLY.has(name)))) continue;
		if (keep && !keep.has(name)) continue;
		out.push(def);
	}
	return out;
}

// ---- key settings ----------------------------------------------------------------------------------------------------

/**
 * Per test type, what a test shows inline: its type, the standard it follows and its headline result. The map's own table
 * (`KEY_SETTING_FIELDS.test`) lists one of each for any test; the form knows the type, so it asks for that type's fields only.
 */
const TEST_KEY_FIELDS: Record<string, readonly string[]> = {
	tensile: ['tensile_uts_mpa'],
	compression: ['compression_yield_strength_mpa'],
	hardness: ['hardness_mean_hardness'],
	charpy: ['charpy_specimen_standard', 'charpy_absorbed_energy_j'],
	tribology: ['tribology_test_standard', 'tribology_coefficient_of_friction'],
};

/**
 * The field names of a container's key settings (map spec §6.4), the ones its card shows inline and the compact form edits.
 * Give an operation's `process_category` ('machining', 'sintering', ...) or a test's `test_type` ('tensile', 'charpy', ...);
 * read from the table the map already draws key settings from (`KEY_SETTING_FIELDS`), so the card and the form agree.
 * A category with none (sample prep) or no value gives none; a test type with no headline result gives just `test_type`.
 */
export function keySettingsFor(processCategoryOrTestType: string | null | undefined): string[] {
	const key = processCategoryOrTestType;
	if (!key || key === 'test') return [];
	const category = (KEY_SETTING_FIELDS as Record<string, { fields: { field: string }[] }[]>)[key];
	if (category) return category.flatMap((def) => def.fields.map((f) => f.field));
	return ['test_type', ...(TEST_KEY_FIELDS[key] ?? [])];
}
