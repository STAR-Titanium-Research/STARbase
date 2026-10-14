// Where the form's record pickers (a many-to-one: Material, Method, Owner, Input sample) look things up.
//
// A collection the Ctrl K finder already searches (samples, operations, tests, campaigns, projects, people,
// inventory) is searched with the finder's own source: same fields, same match columns, same labels. Any other
// collection (materials, methods, equipment, recipes, users) is searched with Directus's `search` parameter and
// labelled from the field's own display template ("{{common_name}} ({{alloy_code}})"). Reads go through the
// host's API, so the signed-in person's permissions decide what can be picked. Pure apart from the api calls.

import { FINDER_SOURCES, sourceParams } from '../finder/finder';
import type { FinderSource } from '../finder/finder';
import type { HostApi } from '../host';

export interface PickerOption {
	id: string;
	label: string;
	detail?: string;
}

/** The target of a many-to-one as the form model knows it. */
export interface RelatedRef {
	collection: string;
	/** The target's key column (`schema.foreign_key_column`), when the definition has it. */
	key?: string | null;
	/** The display template of the field's options. */
	template?: string | null;
}

export interface PickerSource {
	collection: string;
	key: string;
	fields: string[];
	template: string | null;
	finder: FinderSource | null;
}

/** Rows offered at once. */
export const PICK_LIMIT = 8;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** The columns a display template names, nested ones as the dotted path Directus accepts in `fields`. */
export function templateFields(template: string | null | undefined): string[] {
	if (!template) return [];
	return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

const read = (row: any, path: string): unknown => path.split('.').reduce((cur, k) => (cur === null || cur === undefined ? undefined : cur[k]), row);

/** A template filled in from a row; a blank value leaves no dangling separator ("S-1 – " becomes "S-1"). */
export function renderTemplate(template: string, row: unknown): string {
	return template
		.replace(PLACEHOLDER, (_m, path: string) => {
			const v = read(row, path);
			return v === null || v === undefined ? '' : String(v);
		})
		.replace(/\(\s*\)/g, '')
		.replace(/\s+[–-]\s*$/, '')
		.replace(/^\s*[–-]\s+/, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/** The path of a collection's items: system collections have their own endpoint (directus_users -> /users). */
export function itemsPath(collection: string): string {
	return collection.startsWith('directus_') ? `/${collection.slice('directus_'.length)}` : `/items/${collection}`;
}

export function pickerSource(related: RelatedRef): PickerSource {
	const finder = FINDER_SOURCES.find((s) => s.collection === related.collection) ?? null;
	const key = related.key || 'id';
	const template = related.template ?? null;
	const named = templateFields(template);
	const fields = finder ? finder.fields : named.length ? [...new Set([key, ...named])] : ['*'];
	return { collection: related.collection, key, fields, template, finder };
}

// Without a template: the first value that looks like a name or code, else the key.
function guessLabel(row: any, key: string): string {
	for (const [k, v] of Object.entries(row ?? {})) {
		if (/(^|_)(code|name|title|label)$/.test(k) && typeof v === 'string' && v.trim()) return v.trim();
	}
	return String(row?.[key] ?? '');
}

/** One row as an option; null when it has no key. */
export function toOption(src: PickerSource, row: any): PickerOption | null {
	if (!row || typeof row !== 'object') return null;
	if (src.finder) {
		const id = src.finder.record(row).id;
		if (!id || id === 'undefined') return null;
		const detail = src.finder.detail?.(row);
		return { id, label: src.finder.label(row) || id, ...(detail ? { detail } : {}) };
	}
	const raw = row[src.key];
	if (raw === null || raw === undefined) return null;
	const id = String(raw);
	const label = (src.template ? renderTemplate(src.template, row) : guessLabel(row, src.key)) || id;
	return { id, label };
}

/** Params for the list of options: the finder's own query for whatever was typed, plain rows for nothing. */
export function searchParams(src: PickerSource, q: string): Record<string, unknown> {
	const text = q.trim();
	if (src.finder) {
		// The finder itself waits for two characters before it searches; a picker has the list in front of it, so one typed
		// letter already narrows it (sourceParams does not mind the length).
		const base = text ? sourceParams(src.finder, text) : { fields: src.finder.fields };
		return { ...base, limit: PICK_LIMIT };
	}
	return { fields: src.fields, limit: PICK_LIMIT, ...(text ? { search: text } : {}) };
}

/** The options for what was typed. A refusal or a network failure rejects: the picker says it could not search. */
export async function searchOptions(api: HostApi, src: PickerSource, q: string): Promise<PickerOption[]> {
	const res = await api.get(itemsPath(src.collection), { params: searchParams(src, q) });
	const rows = res.data?.data;
	if (!Array.isArray(rows)) return [];
	return rows.map((r) => toOption(src, r)).filter((o): o is PickerOption => o !== null);
}

/** The option for a stored id (to show its label), or null when it cannot be read. */
export async function optionFor(api: HostApi, src: PickerSource, id: string): Promise<PickerOption | null> {
	try {
		const res = await api.get(`${itemsPath(src.collection)}/${encodeURIComponent(id)}`, { params: { fields: src.fields } });
		return toOption(src, res.data?.data);
	} catch {
		return null;
	}
}
