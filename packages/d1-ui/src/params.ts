// Parameters of an operation or a test, with their units.
//
// There is no `*_params` table any more: migration 20260623000032 flattened them into inline
// columns on manufacturing_operations (prefixed by process category: machining_*, sintering_*,
// ht_*, deform_*, am_*) and on test_sessions (prefixed by test type: tensile_*, hardness_* ...).
// Each column is registered in Directus with a condition "show when <discriminator> = <value>",
// a label (translation) and, for measured values, a unit (`options.suffix`), so those three are
// read from the field definitions instead of being copied into a second table here.

import { formatQuantity } from './format';
import { humanise } from './status';

export interface ParamFieldDef {
	field: string;
	type?: string;
	schema?: unknown;
	meta?: {
		sort?: number | null;
		note?: string | null;
		options?: { suffix?: string | null; choices?: { text?: string; value?: unknown }[] | null } | null;
		translations?: { language?: string; translation?: string }[] | null;
		conditions?: { rule?: unknown; hidden?: boolean }[] | null;
		special?: string[] | string | null;
	} | null;
}

export interface ParamRow {
	field: string;
	label: string;
	value: string;
	unit: string;
}

// process_category -> column prefix, for when the field definitions carry no usable condition.
export const OPERATION_PARAM_PREFIX: Record<string, string> = {
	machining: 'machining_',
	sintering: 'sintering_',
	heat_treatment: 'ht_',
	deformation: 'deform_',
	additive: 'am_',
};

export function paramPrefix(discriminator: 'process_category' | 'test_type', value: string): string | null {
	if (discriminator === 'process_category') return OPERATION_PARAM_PREFIX[value] ?? null;
	// test_type 'other' has no parameter columns; every other type is its own prefix (ct_scan_*).
	return value && value !== 'other' ? `${value}_` : null;
}

// The unit of a field: the suffix of its input (`mm`, `MPa`, `°C`). Empty when it has none.
export function fieldUnit(def: ParamFieldDef): string {
	const suffix = def.meta?.options?.suffix;
	return typeof suffix === 'string' ? suffix.trim() : '';
}

// The label the form shows: the English translation, else the column name without its prefix.
export function fieldLabel(def: ParamFieldDef, prefix = ''): string {
	const translations = def.meta?.translations ?? [];
	const en = translations.find((t) => t?.language?.toLowerCase().startsWith('en') && t.translation);
	if (en?.translation) return en.translation.replace(/\?$/, '');
	const bare = prefix && def.field.startsWith(prefix) ? def.field.slice(prefix.length) : def.field;
	return humanise(bare);
}

// Evaluates a Directus condition rule for one discriminator. true / false when the rule decides
// on the discriminator, null when it says nothing about it (a rule on another field).
function ruleMatches(rule: unknown, discriminator: string, value: string): boolean | null {
	if (!rule || typeof rule !== 'object') return null;
	const r = rule as Record<string, any>;
	if (Array.isArray(r._and)) {
		const parts = r._and.map((p: unknown) => ruleMatches(p, discriminator, value));
		if (parts.includes(false)) return false;
		return parts.includes(true) ? true : null;
	}
	if (Array.isArray(r._or)) {
		const parts = r._or.map((p: unknown) => ruleMatches(p, discriminator, value));
		if (parts.includes(true)) return true;
		return parts.includes(false) ? false : null;
	}
	const leaf = r[discriminator];
	if (leaf && typeof leaf === 'object') {
		if ('_eq' in leaf) return leaf._eq === value;
		if ('_neq' in leaf) return leaf._neq !== value;
		if (Array.isArray(leaf._in)) return leaf._in.includes(value);
	}
	return null;
}

// A parameter field is one that a condition shows for this discriminator value.
function shownFor(def: ParamFieldDef, discriminator: string, value: string): boolean {
	return (def.meta?.conditions ?? []).some((c) => c?.hidden === false && ruleMatches(c.rule, discriminator, value) === true);
}

// Specials that mark a relation, file or presentation field rather than a measured value.
const NON_PARAM_SPECIALS = new Set(['m2o', 'o2m', 'm2m', 'm2a', 'file', 'files', 'alias', 'no-data', 'translations']);

function isValueField(def: ParamFieldDef): boolean {
	const special = def.meta?.special;
	const list = Array.isArray(special) ? special : typeof special === 'string' ? special.split(',') : [];
	return !list.some((x) => NON_PARAM_SPECIALS.has(String(x).trim()));
}

// The fields that apply to a row with this process category / test type, in form order. A
// presentation-only field (alias: no column behind it) or a relation / file never applies, and
// neither does a base column that merely shares a condition with the category: the machining
// fields `tool_id`, `gcode_file` or `nc_program_text` are shown "when machining" too, but they
// are not parameters. A parameter column always carries the category's prefix (machining_*,
// tensile_* ...), so a condition-picked field must too.
export function paramFields(
	defs: ParamFieldDef[],
	discriminator: 'process_category' | 'test_type',
	value: string | null | undefined,
): ParamFieldDef[] {
	if (!value) return [];
	const prefix = paramPrefix(discriminator, value);
	if (!prefix) return [];
	const columns = defs.filter((d) => d.schema !== null && isValueField(d) && d.field.startsWith(prefix));
	let picked = columns.filter((d) => shownFor(d, discriminator, value));
	// No usable conditions (an older field registration): fall back to the column prefix.
	if (!picked.length) picked = columns;
	return [...picked].sort((a, b) => (a.meta?.sort ?? 0) - (b.meta?.sort ?? 0) || a.field.localeCompare(b.field));
}

const NUMERIC_TYPES = new Set(['decimal', 'float', 'integer', 'bigInteger']);

function displayValue(def: ParamFieldDef, raw: unknown): string {
	if (raw === null || raw === undefined || raw === '') return '';
	if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
	const choice = def.meta?.options?.choices?.find((c) => c?.value === raw);
	if (choice?.text) return String(choice.text);
	// Postgres NUMERIC columns arrive as strings; a text column that merely looks numeric (a batch
	// number "007") must keep its characters, so only declared numeric types are reformatted.
	if (typeof raw === 'number' || (typeof raw === 'string' && NUMERIC_TYPES.has(def.type ?? '') && Number.isFinite(Number(raw)))) {
		return formatQuantity(raw as number | string);
	}
	return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
}

// The rows of the parameters grid for `row`. Fields without a value are left out, so a category
// with 18 columns and 5 filled in shows 5.
export function paramRows(
	defs: ParamFieldDef[],
	row: Record<string, unknown> | null | undefined,
	discriminator: 'process_category' | 'test_type',
): ParamRow[] {
	if (!row) return [];
	const value = row[discriminator];
	if (typeof value !== 'string') return [];
	const prefix = paramPrefix(discriminator, value) ?? '';
	const out: ParamRow[] = [];
	for (const def of paramFields(defs, discriminator, value)) {
		const text = displayValue(def, row[def.field]);
		if (text === '') continue;
		const numeric = typeof row[def.field] !== 'boolean' && !def.meta?.options?.choices?.some((c) => c?.value === row[def.field]);
		out.push({ field: def.field, label: fieldLabel(def, prefix), value: text, unit: numeric ? fieldUnit(def) : '' });
	}
	return out;
}

// The column names to request for a row: just the parameter columns of its category / type.
export function paramColumns(defs: ParamFieldDef[], discriminator: 'process_category' | 'test_type', value: string | null | undefined): string[] {
	return paramFields(defs, discriminator, value).map((d) => d.field);
}
