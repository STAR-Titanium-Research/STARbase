// Which fields STARbase's form shows for one draft item (spec E15, E17), what the card shows inline as key settings, and how
// the form's answer becomes a change of the draft. Pure, no Vue: DraftItemForm.vue is thin over this.

import { isReserved } from '@d1/ui';
import type { DraftItem, FieldDef, FormField } from '@d1/ui';
import { KEY_SETTING_FIELDS } from '../model/formSlots';

/**
 * Fields the draft fills in by itself where the server has no rule of its own (`@d1/ui` RESERVED_FIELDS is what d1-build
 * refuses and is always left out too): the back-references of the child records and the order of passes.
 */
export const SET_BY_THE_DRAFT: ReadonlySet<string> = new Set(['operation_id', 'session_id', 'operation_sequence']);

/** Codes the database numbers at Create: not asked for on a new record, shown read-only on one that exists. */
export const CODE_FIELDS: ReadonlySet<string> = new Set(['sample_code', 'pass_code', 'test_code']);

/** When it happened: only a record that is done has one (a planned record has `planned_date`). */
export const DONE_DATE_FIELDS: ReadonlySet<string> = new Set(['operation_date', 'session_date']);

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

/** What a field the form cannot draw says on a new item, which has no record to open yet (spec 2026-10-18 §3, item 12). */
export const NEW_RECORD_EXTERNAL = 'Opens in Data Studio after Create';

const COLLECTION: Record<DraftItem['kind'], string> = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' };
/** The Directus collection a draft item's record lives in. */
export const collectionFor = (item: DraftItem): string => COLLECTION[item.kind];

export interface FormDefsOptions {
	/** Only these fields (the card's key settings), in the form's own order. */
	keyFields?: readonly string[];
	compact?: boolean;
}

/**
 * The definitions to draw for `item`: without what the server refuses in a draft (`isReserved`: wires, work state, a sample's
 * status, a test's subject, stamps) or the draft fills in itself, without the codes on a new record, without the date it was done
 * while it is planned, and for a compact form only `keyFields`. A field group whose fields are all left out draws nothing
 * (FieldForm hides empty groups).
 */
export function formDefsFor(defs: readonly unknown[], item: DraftItem, opts: FormDefsOptions = {}): FieldDef[] {
	const keep = opts.compact ? new Set(opts.keyFields ?? []) : null;
	const isNew = !item.existing;
	const planned = item.kind !== 'sample' && item.workState === 'planned';
	const out: FieldDef[] = [];
	for (const d of defs) {
		const def = d as FieldDef | null;
		if (!def || typeof def.field !== 'string') continue;
		const name = def.field;
		if (isReserved(item.kind, name) || SET_BY_THE_DRAFT.has(name)) continue;
		if (isNew && CODE_FIELDS.has(name)) continue;
		if (planned && DONE_DATE_FIELDS.has(name)) continue;
		if (keep && !keep.has(name)) continue;
		out.push(def);
	}
	return out;
}

// ---- what the form changes ----------------------------------------------------------------------------------------------

/**
 * The change of the draft for the form's new values, ready for `setValues` (which merges): everything the form has now, and
 * every key the item had that the form dropped (FieldForm drops a cleared field's key) as `undefined`, which removes it from a
 * new record, or `null` for an existing record, where a cleared field has to be written as empty at Create.
 */
export function patchOf(item: DraftItem, next: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = { ...next };
	for (const key of Object.keys(item.values)) {
		if (!(key in next)) patch[key] = item.existing ? null : undefined;
	}
	return patch;
}

/** The values an existing record's form edits: the record as loaded, with the draft's changes over it (a `null` change clears). */
export function existingModel(item: DraftItem, current: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...current };
	for (const [k, v] of Object.entries(item.values)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * For an existing record edited over its loaded values (`existingModel`): the patch for setValues that leaves in the draft only
 * what differs from the record. A field changed → its value; a field the record has and the form cleared → `null`; a field
 * changed back to the record's value, or a change the record never had a value for and was cleared → `undefined` (dropped).
 */
export function existingPatch(item: DraftItem, current: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(current), ...Object.keys(item.values), ...Object.keys(next)]);
	for (const k of keys) {
		const had = current[k];
		const hasHad = had !== undefined && had !== null && had !== '';
		if (k in next) patch[k] = same(next[k], had) ? undefined : next[k];
		else if (hasHad) patch[k] = null;
		else if (k in item.values) patch[k] = undefined;
	}
	for (const k of Object.keys(patch)) if (patch[k] === undefined && !(k in item.values)) delete patch[k];
	return patch;
}

/**
 * What the form greys as inherited, without the fields the person has cleared on an existing record (`null` in its changes):
 * those show empty, not the value the record still has until Create.
 */
export function inheritedFor(item: DraftItem, inherited: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!inherited || !item.existing) return inherited;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(inherited)) if (item.values[k] !== null) out[k] = v;
	return out;
}

// ---- key settings ----------------------------------------------------------------------------------------------------

/**
 * Per test type, what a test shows inline besides its type: the standard it follows and its headline result. The map's own table
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
 * An operation gives its `process_category` ('machining', 'sintering', ...), read from the table the map already draws key
 * settings from (`KEY_SETTING_FIELDS`), so the card and the form agree; a category with none (sample prep) or no value gives
 * none. A test gives its `test_type` ('tensile', 'charpy', ...) and always starts with `test_type` itself, even while it is
 * unset, so the type can be chosen: then that type's standard and headline result.
 */
export function keySettingsFor(kind: 'operation' | 'test', value: string | null | undefined): string[] {
	if (kind === 'test') return ['test_type', ...(value ? (TEST_KEY_FIELDS[value] ?? []) : [])];
	const category = value ? (KEY_SETTING_FIELDS as Record<string, { fields: { field: string }[] }[]>)[value] : undefined;
	return category && value !== 'test' ? category.flatMap((def) => def.fields.map((f) => f.field)) : [];
}
