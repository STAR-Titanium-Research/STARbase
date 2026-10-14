// The generated form's model: Directus field definitions (GET /fields/<collection>) turned into FormField[], plus
// the pure helpers FieldForm.vue is thin over. No Vue, no host (spec 2026-10-14 section 7.3, ADR-0018).
//
// What is read from a definition: the Field group it sits in (meta.group), sort, width, label (the English
// translation, else the humanised column), note, required, hidden, read-only, conditions, and by interface:
// choices (select-dropdown, select-radio), suffix / step / min / max (input), and for a many-to-one the related
// collection (schema.foreign_key_table) and the template its options give. A field this cannot draw becomes
// kind 'external': the form shows its value and "Open in Data Studio" instead.

import { applyConditions } from './conditions';
import type { AppliedConditions, FieldCondition, Values } from './conditions';
import { fieldLabel, fieldUnit } from '../params';

export type FieldKind =
	| 'group'
	| 'text'
	| 'textarea'
	| 'number'
	| 'select'
	| 'radio'
	| 'toggle'
	| 'date'
	| 'datetime'
	| 'time'
	| 'record'
	| 'person'
	| 'external';

export interface FieldChoice {
	text: string;
	value: string | number | boolean;
}

export interface FormField {
	field: string;
	label: string;
	note: string | null;
	kind: FieldKind;
	/** The Field group (its `field` name) this sits in; null at the top. */
	group: string | null;
	sort: number;
	width: 'half' | 'full';
	/** Directus type of the column ('string', 'decimal', 'timestamp', 'alias'...). */
	type: string;
	/** The interface Data Studio would draw it with (a custom one for 'external' fields). */
	interfaceName: string | null;
	/** True as the field's own base state: conditions can still show it. */
	hidden: boolean;
	readonly: boolean;
	required: boolean;
	conditions: FieldCondition[];
	suffix: string;
	choices: FieldChoice[];
	/** select-dropdown with "allow other": a value outside the choices is kept. */
	allowOther: boolean;
	placeholder: string | null;
	min: number | null;
	max: number | null;
	step: number | null;
	/** Whole numbers only (integer columns). */
	integer: boolean;
	/** For kind 'record' / 'person': where the id points, and the display template of the field's options. */
	related: { collection: string; template: string | null } | null;
	/** Groups only: starts collapsed. */
	collapsed: boolean;
}

/** A field definition as Directus describes it; only `field` is required, everything else is read defensively. */
export type FieldDef = Record<string, any> & { field: string };

export interface FormFieldOptions {
	/** field -> related collection, for a host whose definitions carry no `schema.foreign_key_table`. */
	relations?: Record<string, string>;
	/** Per-field changes applied last (a stream that knows better: a different kind, readonly, a label). */
	override?: Record<string, Partial<FormField>>;
}

const MAX_SORT = Number.MAX_SAFE_INTEGER;
const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal']);
const INTEGER_TYPES = new Set(['integer', 'bigInteger']);
const SYSTEM_SPECIALS = new Set(['date-created', 'date-updated', 'user-created', 'user-updated']);
// Interfaces for a value in a column of many values or a file: drawn in Data Studio only.
const RELATION_SPECIALS = new Set(['o2m', 'm2m', 'm2a', 'file', 'files', 'translations']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function specials(def: FieldDef): string[] {
	const s = def.meta?.special;
	const list = Array.isArray(s) ? s : typeof s === 'string' ? s.split(',') : [];
	return list.map((x) => String(x).trim()).filter(Boolean);
}

function typeOf(def: FieldDef): string {
	return str(def.type) ?? str(def.schema?.data_type) ?? 'unknown';
}

export function isGroup(def: FieldDef): boolean {
	return specials(def).includes('group') || String(def.meta?.interface ?? '').startsWith('group-');
}

/** A column nobody types into: the key, a stamp the server sets, or a presentation-only alias. */
function isSystem(def: FieldDef): boolean {
	if (isGroup(def)) return false;
	const sp = specials(def);
	if (def.schema?.is_primary_key) return true;
	if (sp.some((x) => SYSTEM_SPECIALS.has(x))) return true;
	return sp.includes('no-data'); // report_button, dividers, notices
}

function choicesOf(def: FieldDef): FieldChoice[] {
	const raw = def.meta?.options?.choices;
	if (!Array.isArray(raw)) return [];
	const out: FieldChoice[] = [];
	for (const c of raw) {
		if (c === null || typeof c !== 'object' || c.value === undefined || c.value === null) continue;
		out.push({ text: str(c.text) ?? String(c.value), value: c.value });
	}
	return out;
}

function conditionsOf(def: FieldDef): FieldCondition[] {
	const raw = def.meta?.conditions;
	return Array.isArray(raw) ? raw.filter((c): c is FieldCondition => c !== null && typeof c === 'object') : [];
}

function relatedOf(def: FieldDef, opts: FormFieldOptions): FormField['related'] {
	const collection = str(def.schema?.foreign_key_table) ?? opts.relations?.[def.field] ?? null;
	if (!collection) return null;
	return { collection, template: str(def.meta?.options?.template) };
}

function kindOf(def: FieldDef, related: FormField['related'], choices: FieldChoice[]): FieldKind {
	if (isGroup(def)) return 'group';
	const sp = specials(def);
	const type = typeOf(def);
	const iface = str(def.meta?.interface);
	if (sp.some((x) => RELATION_SPECIALS.has(x)) || sp.includes('alias')) return 'external';
	// A foreign key is a record picker whether or not Directus marked it m2o; an m2o with no known target is not drawable.
	if (sp.includes('m2o') || related) return related ? (related.collection === 'people' ? 'person' : 'record') : 'external';
	if (type === 'json' || type === 'csv' || type === 'hash' || type.startsWith('geometry')) return 'external';

	const byType = (): FieldKind => {
		if (type === 'boolean') return 'toggle';
		if (NUMERIC_TYPES.has(type)) return 'number';
		if (type === 'date') return 'date';
		if (type === 'time') return 'time';
		if (type === 'dateTime' || type === 'timestamp') return 'datetime';
		return 'text';
	};
	switch (iface) {
		case null:
		case 'input': {
			// TEXT is the usual column type here, and an `input` is one line whatever the column: multi-line is its own interface.
			return byType();
		}
		case 'input-multiline':
			return 'textarea';
		case 'boolean':
		case 'toggle':
			return 'toggle';
		case 'datetime': {
			const k = byType();
			return k === 'date' || k === 'time' ? k : 'datetime';
		}
		case 'slider':
			return 'number';
		case 'select-dropdown':
			return choices.length ? 'select' : 'external';
		case 'select-radio':
			return choices.length ? 'radio' : 'external';
		default:
			return 'external';
	}
}

/** The form's fields (groups included) in form order: sorted as Data Studio sorts, one entry per drawable definition. */
export function toFormFields(defs: readonly FieldDef[], opts: FormFieldOptions = {}): FormField[] {
	const out: FormField[] = [];
	for (const def of defs) {
		if (!def || typeof def.field !== 'string' || isSystem(def)) continue;
		const meta = def.meta ?? {};
		const choices = choicesOf(def);
		const related = relatedOf(def, opts);
		const kind = kindOf(def, related, choices);
		const type = typeOf(def);
		const options = meta.options ?? {};
		const width = meta.width === 'full' || meta.width === 'fill' || kind === 'group' ? 'full' : 'half';
		const f: FormField = {
			field: def.field,
			label: fieldLabel(def as any),
			note: str(meta.note),
			kind,
			group: str(meta.group),
			sort: num(meta.sort) ?? MAX_SORT,
			width,
			type,
			interfaceName: str(meta.interface),
			hidden: !!meta.hidden,
			readonly: !!meta.readonly,
			required: !!meta.required,
			conditions: conditionsOf(def),
			suffix: fieldUnit(def as any),
			choices,
			allowOther: !!options.allowOther,
			placeholder: str(options.placeholder),
			min: num(options.min),
			max: num(options.max),
			step: num(options.step),
			integer: INTEGER_TYPES.has(type),
			related: kind === 'record' || kind === 'person' ? related : null,
			collapsed: kind === 'group' && options.start === 'closed',
		};
		out.push(f);
	}
	// Stable: equal sorts keep the order Directus sent them in.
	const order = new Map(out.map((f, i) => [f.field, i]));
	out.sort((a, b) => a.sort - b.sort || (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0));
	if (opts.override) {
		return out.map((f) => {
			const o = opts.override?.[f.field];
			return o ? { ...f, ...o, field: f.field } : f;
		});
	}
	return out;
}

export interface FormNode {
	field: FormField;
	children: FormNode[];
}

/**
 * The fields as a tree of groups: a field sits under the group its `group` names. A field whose group is not
 * among `fields` (not readable, or a loop) goes to the top, so nothing is lost.
 */
export function formTree(fields: readonly FormField[]): FormNode[] {
	const byName = new Map(fields.map((f) => [f.field, f]));
	const nodes = new Map<string, FormNode>(fields.map((f) => [f.field, { field: f, children: [] }]));
	const parentOf = (f: FormField): string | null => {
		const p = f.group;
		if (!p || p === f.field) return null;
		const parent = byName.get(p);
		if (!parent || parent.kind !== 'group') return null;
		// A loop (a is in b, b is in a) must not swallow both: the later one in the chain goes to the top.
		const seen = new Set([f.field]);
		for (let cur: string | null = p; cur; cur = byName.get(cur)?.group ?? null) {
			if (seen.has(cur)) return null;
			seen.add(cur);
		}
		return p;
	};
	const roots: FormNode[] = [];
	for (const f of fields) {
		const node = nodes.get(f.field);
		if (!node) continue;
		const p = parentOf(f);
		if (p) nodes.get(p)?.children.push(node);
		else roots.push(node);
	}
	return roots;
}

/** What a field is for these values: conditions applied, and hidden when a group above it is hidden. */
export interface FieldView extends AppliedConditions {
	/** Hidden by its own state or a group above it. */
	hiddenByGroup: boolean;
}

/** The live state of every field for `values` (conditions applied; a hidden group hides what is in it). */
export function fieldViews(fields: readonly FormField[], values: Values): Map<string, FieldView> {
	const byName = new Map(fields.map((f) => [f.field, f]));
	const own = new Map<string, AppliedConditions>();
	for (const f of fields) {
		own.set(f.field, applyConditions({ hidden: f.hidden, readonly: f.readonly, required: f.required }, f.conditions, values));
	}
	const out = new Map<string, FieldView>();
	for (const f of fields) {
		const mine = own.get(f.field) as AppliedConditions;
		let hiddenByGroup = false;
		const seen = new Set([f.field]);
		for (let cur = f.group; cur && !seen.has(cur); cur = byName.get(cur)?.group ?? null) {
			seen.add(cur);
			if (own.get(cur)?.hidden) hiddenByGroup = true;
		}
		out.set(f.field, { ...mine, hidden: mine.hidden || hiddenByGroup, hiddenByGroup });
	}
	return out;
}

/** No value: null, undefined, blank text, an empty list. 0 and false are values. */
export function isEmptyValue(v: unknown): boolean {
	if (v === null || v === undefined) return true;
	if (typeof v === 'string') return v.trim() === '';
	if (Array.isArray(v)) return v.length === 0;
	return false;
}

/** The shown, writable, required fields that have no value yet, in form order. Groups never count. */
export function missingRequired(fields: readonly FormField[], values: Values, views?: ReadonlyMap<string, FieldView>): FormField[] {
	const live = views ?? fieldViews(fields, values);
	return fields.filter((f) => {
		if (f.kind === 'group') return false;
		const v = live.get(f.field);
		return !!v && !v.hidden && v.required && isEmptyValue(values[f.field]);
	});
}

/** The text of a choice value ('MT-F' -> "Turning – Facing"); the value itself when it is no choice. */
export function choiceText(field: FormField, value: unknown): string {
	const hit = field.choices.find((c) => String(c.value) === String(value));
	return hit ? hit.text : String(value ?? '');
}

/** A value shown as text: choices by their text, yes/no, numbers and lists plainly, an object as JSON. Empty is ''. */
export function displayText(field: FormField, value: unknown): string {
	if (isEmptyValue(value)) return '';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (field.choices.length) return choiceText(field, value);
	if (Array.isArray(value)) return value.length === 1 ? displayText(field, value[0]) : `${value.length} items`;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}
