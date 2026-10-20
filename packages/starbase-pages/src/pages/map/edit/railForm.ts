// What the rail's form for the selected draft item draws and does, apart from Vue (pure, tested): which fields are its key settings,
// and the extra change a new method makes (the process category the typed parameter panels hang on follows the method).

import type { DraftItem } from '@d1/ui';
import type { ProcessCategory } from '../model/types';
import { keySettingsFor } from './draftForm';
import { DONE_DATE_FIELD } from './workState';

/** A new sample's key fields: what its code is made of, and what it is. Fields a collection does not have are left out by the form. */
export const SAMPLE_KEY_FIELDS = ['material_id', 'primary_method_id', 'form', 'mass_grams', 'diameter_mm', 'thickness_mm', 'length_mm'];

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The fields of the compact form of an item: a sample's key fields; an operation's method, machine and planned date and then the key
 * settings of its process category; a test's type, its key results, the machine and the planned date. `loaded` is the record of an
 * item that exists (its category and test type are there, not in the draft's changes). A new item that is done (R9) asks for the date it
 * happened instead of the planned date, and for `requiredForDone` (the fields the forms mark required, `doneRequiredFields`): what Create
 * would refuse it without sits where it can be filled in, not only in "All fields".
 */
export function keyFieldsFor(item: DraftItem, loaded?: Record<string, unknown>, requiredForDone: readonly string[] = []): string[] {
	if (item.kind === 'sample') return SAMPLE_KEY_FIELDS;
	const own = { ...(loaded ?? {}), ...item.values };
	const done = !item.existing && item.workState === 'done';
	const when = done ? DONE_DATE_FIELD[item.kind] : 'planned_date';
	const asked = done ? requiredForDone : [];
	const unique = (fields: string[]) => [...new Set(fields)];
	if (item.kind === 'operation') return unique(['method_id', 'equipment_id', when, ...asked, ...keySettingsFor('operation', text(own.process_category))]);
	const results = keySettingsFor('test', text(own.test_type));
	return unique([...results, 'equipment_id', when, ...asked]);
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
