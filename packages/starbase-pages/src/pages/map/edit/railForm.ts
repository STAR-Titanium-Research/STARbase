// What the rail's form for the selected draft item draws and does, apart from Vue (pure, tested): which fields are its key settings,
// and the extra change a new method makes (the process category the typed parameter panels hang on follows the method).

import type { DraftItem } from '@d1/ui';
import type { ProcessCategory } from '../model/types';
import { keySettingsFor } from './draftForm';

/** A new sample's key fields: what its code is made of, and what it is. Fields a collection does not have are left out by the form. */
export const SAMPLE_KEY_FIELDS = ['material_id', 'primary_method_id', 'form', 'mass_grams', 'diameter_mm', 'thickness_mm', 'length_mm'];

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The fields of the compact form of an item: a sample's key fields; an operation's method, machine and planned date and then the key
 * settings of its process category; a test's type, its key results, the machine and the planned date. `loaded` is the record of an
 * item that exists (its category and test type are there, not in the draft's changes).
 */
export function keyFieldsFor(item: DraftItem, loaded?: Record<string, unknown>): string[] {
	if (item.kind === 'sample') return SAMPLE_KEY_FIELDS;
	const own = { ...(loaded ?? {}), ...item.values };
	if (item.kind === 'operation') return ['method_id', 'equipment_id', 'planned_date', ...keySettingsFor('operation', text(own.process_category))];
	const planned = ['equipment_id', 'planned_date'];
	return [...keySettingsFor('test', text(own.test_type)), ...planned.filter((f) => !keySettingsFor('test', text(own.test_type)).includes(f))];
}

/**
 * A change to an operation's method also sets the process category of that method (null leaves it empty): the form's typed panels and
 * the database's own rule both read it, and a category left over from the old method would put the wrong panels up.
 */
export function withCategory(item: DraftItem, patch: Record<string, unknown>, categoryOf: (methodId: string) => ProcessCategory | undefined): Record<string, unknown> {
	if (item.kind !== 'operation' || !('method_id' in patch)) return patch;
	const next = text(patch.method_id);
	if (next === item.values.method_id) return patch;
	const category = next ? categoryOf(next) : undefined;
	return { ...patch, process_category: category ?? (item.existing ? null : undefined) };
}

/** The title of the item's section: "New sample", "Operation". */
export function formTitle(item: DraftItem): string {
	const word = item.kind === 'sample' ? 'sample' : item.kind === 'operation' ? 'operation' : 'test';
	return item.existing ? `${word[0].toUpperCase()}${word.slice(1)}` : `New ${word}`;
}
