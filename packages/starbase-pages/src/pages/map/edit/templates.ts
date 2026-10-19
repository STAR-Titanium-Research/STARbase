// Templates (redesign R7, spec E11), as pure functions: what a template saves of a container, what the palette and the add search list
// of them, who may change one, and how the answers of `/d1-build/templates` are read. No Vue, no I/O: useTemplates.ts reads and writes.
//
// A template is an operation method or a test type plus its filled-in fields (machine, tool, operator, settings...): never the sample links,
// the dates or the work state of the container it was made from, and notes only when the person asks for them. What is made from a
// template is a plain new container with those values, editable afterwards and not linked to the template (the draft's `addContainer` from
// 'template' copies the values), so changing a template never changes what was made from it.

import type { DraftItem, FieldDef as DirectusField, TemplateRecord } from '@d1/ui';
import type { ProcessCategory } from '../model/types';
import { writableValues, type MethodEntry, type TestTypeEntry } from './catalog';
import { newFromValues } from './draft';
import { gearIn, type GearField } from './gearStatus';
import type { MenuEntry } from './menuModel';

export type TemplateScope = TemplateRecord['scope'];
export type TemplateCollection = TemplateRecord['collection'];

/** The three scopes of the saved views, in the words of the lab (CONTEXT.md: one person, their account role, the whole group). */
export const SCOPES: { value: TemplateScope; label: string; hint: string }[] = [
	{ value: 'private', label: 'Only me', hint: 'Only you see it.' },
	{ value: 'role', label: 'My account role', hint: 'Everyone with your account role sees it.' },
	{ value: 'global', label: 'Everyone', hint: 'Everyone who can build processes sees it.' },
];
export const scopeLabel = (scope: TemplateScope): string => SCOPES.find((s) => s.value === scope)?.label ?? scope;

/** The section the templates are listed under: the first of the palette and the add search. */
export const TEMPLATES = 'Templates';

const COLLECTIONS: readonly string[] = ['manufacturing_operations', 'test_sessions'];
const isScope = (v: unknown): v is TemplateScope => v === 'private' || v === 'role' || v === 'global';
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The templates of `GET /d1-build/templates`; a row that is not a template (no id, name or values) is dropped, never trusted. */
export function templatesOf(rows: unknown): TemplateRecord[] {
	if (!Array.isArray(rows)) return [];
	const out: TemplateRecord[] = [];
	for (const r of rows) {
		if (!isObject(r) || typeof r.id !== 'string' || typeof r.name !== 'string' || !isScope(r.scope)) continue;
		if (typeof r.collection !== 'string' || !COLLECTIONS.includes(r.collection) || !isObject(r.values)) continue;
		out.push({
			id: r.id,
			name: r.name,
			scope: r.scope,
			role_id: typeof r.role_id === 'string' ? r.role_id : null,
			collection: r.collection as TemplateCollection,
			values: r.values,
			user_id: typeof r.user_id === 'string' ? r.user_id : '',
			updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
			version: Number.isFinite(Number(r.version)) ? Number(r.version) : 1,
		});
	}
	return out;
}

// ---- what a template saves ---------------------------------------------------------------------------------------------

/**
 * Left out of a template on top of what "new from" leaves out (`newFromValues`: the date, the sample, the codes, the owner, the notes, the
 * record's bookkeeping): the project and campaign (the draft's top bar chooses them), the outcome and the files of one particular run.
 */
const NOT_IN_A_TEMPLATE = new Set(['project_id', 'campaign_id', 'outcome_notes', 'force_file_id', 'file_storage_pointer', 'nc_program_file_uri', 'recorded_at']);

const blank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * What a container's template holds: its fields as they will stand (the loaded record of one that exists, then the draft's changes), without the
 * fields the server refuses in a draft, the ones that are only true of this run (see above) and anything blank. `notes` stays only when
 * `opts.notes` is ticked. `defs` are the collection's field definitions: only real columns are kept (the server refuses a name that is not one).
 */
export function templateValuesOf(item: DraftItem, loaded: Record<string, unknown> | undefined, defs: readonly DirectusField[], opts: { notes?: boolean } = {}): Record<string, unknown> {
	const own: Record<string, unknown> = { ...(loaded ?? {}) };
	// A change to null clears the field of the record it is a change of.
	for (const [k, v] of Object.entries(item.values)) {
		if (v === null) delete own[k];
		else if (v !== undefined) own[k] = v;
	}
	const writable = writableValues(item.kind, own, defs);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(newFromValues(writable))) if (!NOT_IN_A_TEMPLATE.has(k) && !blank(v)) out[k] = v;
	if (opts.notes && !blank(writable.notes)) out.notes = writable.notes;
	return out;
}

/** Why a container cannot be saved as a template, or null: the server wants the method of an operation and the type of a test. */
export function templateProblem(item: DraftItem | null | undefined, values: Record<string, unknown>): string | null {
	if (!item || item.kind === 'sample') return 'Only an operation or a test can be saved as a template.';
	if (item.kind === 'operation' && typeof values.method_id !== 'string') return 'Choose the method of this operation first.';
	if (item.kind === 'test' && blank(values.test_type)) return 'Choose the type of this test first.';
	return null;
}

/** The collection a draft item's template is for (null for a sample). */
export const templateCollectionOf = (item: DraftItem | null | undefined): TemplateCollection | null =>
	item?.kind === 'operation' ? 'manufacturing_operations' : item?.kind === 'test' ? 'test_sessions' : null;

// ---- who may change one -------------------------------------------------------------------------------------------------

/** d1-build lets the person who made a template, or an administrator, change or delete it; everyone else only uses it. */
export const canChange = (t: Pick<TemplateRecord, 'user_id'>, me: { id?: string | null; admin?: boolean }): boolean => !!me.admin || (!!me.id && t.user_id === me.id);

// ---- what the palette and the add search list ---------------------------------------------------------------------------

/** A template with what the page knows about it: whether this person may change it and what is wrong with the gear it names. */
export interface TemplateItem {
	rec: TemplateRecord;
	/** The person may rename, re-scope, replace or delete it. */
	mine: boolean;
	/** A retired machine or tool, or a used-up edge it names (the template is listed greyed with this said). */
	warn?: string;
}

/** What a template's entry carries for the palette's controls (rename, scope, replace, delete). */
export interface TemplateInfo {
	id: string;
	name: string;
	scope: TemplateScope;
	collection: TemplateCollection;
	mine: boolean;
	version: number;
}

export interface TemplateCatalog {
	methods: readonly MethodEntry[];
	testTypes: readonly TestTypeEntry[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The entry of one template: found by its name, its method or test type and "template"; it is chosen like the method or test it is made of. */
export function templateEntry(t: TemplateItem, cat: TemplateCatalog): MenuEntry {
	const { rec } = t;
	const info: TemplateInfo = { id: rec.id, name: rec.name, scope: rec.scope, collection: rec.collection, mine: t.mine, version: rec.version };
	const shared = rec.scope === 'private' ? '' : ` · ${scopeLabel(rec.scope)}`;
	if (rec.collection === 'manufacturing_operations') {
		const methodId = text(rec.values.method_id);
		const method = cat.methods.find((m) => m.id === methodId);
		const category: ProcessCategory = method?.category ?? ((text(rec.values.process_category) || null) as ProcessCategory);
		const values = category && !rec.values.process_category ? { ...rec.values, process_category: category } : rec.values;
		return {
			id: `tpl:${rec.id}`, section: TEMPLATES, label: rec.name, detail: `${method?.name ?? 'Operation'}${shared}`,
			keys: `template ${method?.name ?? ''} ${method?.code ?? ''}`, template: info, ...(t.warn ? { warn: t.warn } : {}),
			choice: { kind: 'operation', methodId, category, template: { id: rec.id, values } },
		};
	}
	const type = text(rec.values.test_type);
	const name = cat.testTypes.find((x) => x.value === type)?.name ?? (type || 'Test');
	return {
		id: `tpl:${rec.id}`, section: TEMPLATES, label: rec.name, detail: `${name}${shared}`, keys: `template test ${name} ${type}`,
		template: info, ...(t.warn ? { warn: t.warn } : {}),
		choice: { kind: 'test', testType: type, template: { id: rec.id, values: rec.values } },
	};
}

/** The templates as catalog entries, by name; `only` narrows to the operations or the tests (an insert takes operations only). */
export function templateEntries(items: readonly TemplateItem[], cat: TemplateCatalog, only?: 'operation' | 'test'): MenuEntry[] {
	return items
		.filter((t) => !only || (only === 'operation') === (t.rec.collection === 'manufacturing_operations'))
		.map((t) => templateEntry(t, cat))
		.sort((a, b) => a.label.localeCompare(b.label));
}

// ---- reading the gear a template names ----------------------------------------------------------------------------------

/** The one warning of a template: the first thing it names that is retired or used up, said in the lab's words. */
export function warnOf(values: Record<string, unknown>, problem: (field: GearField, id: string) => string | undefined): string | undefined {
	for (const g of gearIn(values)) {
		const p = problem(g.field, g.id);
		if (p) return p;
	}
	return undefined;
}
