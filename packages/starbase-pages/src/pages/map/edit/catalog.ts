// What edit mode reads from the server besides the draft (pure mappers, no Vue, no I/O): the methods and the test types the Add
// menu offers, the field definitions the checks and the form read, and the existing records a draft holds. useEditCatalog.ts
// does the reading; the shapes of the answers are turned into the shapes the edit model wants here, where they are tested.

import { isReserved, toFormFields, type DraftKind, type FieldDef as DirectusField } from '@d1/ui';
import type { ProcessCategory } from '../model/types';
import type { CheckCollection, FieldDef, LoadedRecord } from './checks';
import { OWNER_FIELDS } from './draft';

export const CATEGORIES: ProcessCategory[] = ['machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep'];

export interface MethodEntry {
	id: string;
	name: string;
	code: string;
	category: ProcessCategory;
}

export interface TestTypeEntry {
	value: string;
	name: string;
}

/** Fields of manufacturing_methods the Add menu reads (db/migrations 20260618000002 and 20261003000129). */
export const METHOD_FIELDS = ['method_id', 'method_name', 'method_code', 'process_category'];

/** The primary key column of the three collections a draft holds. */
export const KEY_FIELD: Record<CheckCollection, string> = {
	physical_samples: 'sample_id',
	manufacturing_operations: 'operation_id',
	test_sessions: 'session_id',
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The methods of `GET /items/manufacturing_methods`, by name; rows with no id are dropped. */
export function methodsOf(rows: readonly Record<string, unknown>[]): MethodEntry[] {
	const out: MethodEntry[] = [];
	for (const r of rows) {
		const id = text(r.method_id);
		if (!id) continue;
		const category = (CATEGORIES as readonly unknown[]).includes(r.process_category) ? (r.process_category as ProcessCategory) : null;
		out.push({ id, name: text(r.method_name) || text(r.method_code) || 'Method', code: text(r.method_code), category });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The test types a test can have: the choices of `test_sessions.test_type`. */
export function testTypesOf(defs: readonly DirectusField[]): TestTypeEntry[] {
	const raw = defs.find((d) => d.field === 'test_type')?.meta?.options?.choices;
	if (!Array.isArray(raw)) return [];
	const out: TestTypeEntry[] = [];
	for (const c of raw) {
		if (c === null || typeof c !== 'object' || c.value === undefined || c.value === null || c.value === '') continue;
		out.push({ value: String(c.value), name: text(c.text) || String(c.value) });
	}
	return out;
}

/** What the checks read of a collection's field definitions: which are required, and what to call them. */
export function checkFieldsOf(defs: readonly DirectusField[]): FieldDef[] {
	return toFormFields(defs)
		.filter((f) => f.kind !== 'group')
		.map((f) => ({ field: f.field, required: f.required, label: f.label, hidden: f.hidden, readonly: f.readonly }));
}

/** An existing record as the checks read it (`GET /items` row with its `version`); null for a row with no version. */
export function loadedRecordOf(row: Record<string, unknown>): LoadedRecord | null {
	const version = Number(row.version);
	if (!Number.isFinite(version)) return null;
	return { version, values: row };
}

/** The ids of the existing records of a draft, by collection. */
export function existingIds(items: readonly { kind: 'sample' | 'operation' | 'test'; existing?: { id: string } }[]): Record<CheckCollection, string[]> {
	const out: Record<CheckCollection, string[]> = { physical_samples: [], manufacturing_operations: [], test_sessions: [] };
	const collection = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' } as const;
	for (const i of items) if (i.existing && !out[collection[i.kind]].includes(i.existing.id)) out[collection[i.kind]].push(i.existing.id);
	return out;
}

/** A column of the table (not an alias: a many-to-many, a one-to-many, a presentation field, a translation list). */
const isColumn = (d: DirectusField): boolean => {
	if (d.type === 'alias' || !d.schema) return false;
	const special = d.meta?.special;
	const list = Array.isArray(special) ? special : typeof special === 'string' ? special.split(',') : [];
	return !list.some((x: string) => ['alias', 'no-data', 'o2m', 'm2m', 'm2a', 'files', 'translations', 'group'].includes(x.trim()));
};

/**
 * The part of an existing record's row that a new draft item may carry (a duplicate, "new from"): real columns only, none the server
 * refuses in a draft (`RESERVED_FIELDS`: the keys, the work state, short_id, code_sort, restricted...), not the owner (a copy is the
 * copier's, `OWNER_FIELDS`), no alias arrays, no relation
 * read as an object. `defs` are the collection's field definitions; without them only plain values are kept.
 */
export function writableValues(kind: DraftKind, record: Record<string, unknown>, defs: readonly DirectusField[] = []): Record<string, unknown> {
	const columns = defs.length ? new Set(defs.filter(isColumn).map((d) => d.field)) : null;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) {
		if (v === undefined || isReserved(kind, k) || OWNER_FIELDS.includes(k)) continue;
		if (columns ? !columns.has(k) : v !== null && typeof v === 'object') continue;
		out[k] = v;
	}
	return out;
}
