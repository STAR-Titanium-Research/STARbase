// Pure helpers of the labels page: what it reads, how it reads ?ids= and pasted codes, which template
// is shown first, who may change a template and exactly what a save sends. No Vue, no Directus imports.
import { templateFromRow, validateTemplate } from './template';
import type { Arrangement, FieldKey, LabelField, LabelSample, LabelTemplate } from './types';

// Reads of physical_samples for the page: exactly what toLabelSample documents.
export const LABEL_SAMPLE_FIELDS = [
	'sample_id', 'sample_code', 'short_id', 'nickname',
	'material_id.common_name', 'material_id.alloy_code',
	'manufactured_date', 'created_at', 'owner_person_id.full_name',
];

// ---- what the URL and the paste box ask for -------------------------------------------------------

type Query = Record<string, unknown>;

// ?ids=a,b or ?ids=a&ids=b (the old redirect sends the first form), de-duplicated, in order.
function queryValues(v: unknown): string[] {
	const raw = Array.isArray(v) ? v : [v];
	return raw.flatMap((x) => (typeof x === 'string' ? x.split(/[,\s]+/) : [])).map((x) => x.trim()).filter(Boolean);
}
const unique = (xs: string[]): string[] => [...new Set(xs)];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sample ids (anything that is not a uuid is dropped: it could never match, and the filter stays valid) and
// codes asked for by the route's query.
export function parseSelectionQuery(query: Query): { ids: string[]; codes: string[] } {
	return {
		ids: unique(queryValues(query.ids).filter((x) => UUID_RE.test(x)).map((x) => x.toLowerCase())),
		codes: unique(queryValues(query.codes)),
	};
}

// Sample codes pasted into the box: one per line, or separated by commas, semicolons or tabs. A code may
// contain spaces, so those do not separate.
export function parseCodes(text: string): string[] {
	return unique(text.split(/[\r\n,;\t]+/).map((x) => x.trim()).filter(Boolean));
}

// The filter of the sample picker: free-text search over code, nickname and short id, a project (by the
// project rule of sampleProjectScopeFilter) and a campaign (through the campaign_samples junction).
// `projectScope` is that rule's filter for the chosen project, built by the caller.
export function pickerFilter(opts: { search: string; campaignId: string; projectScope: Record<string, unknown> | null }): Record<string, unknown> {
	const and: Record<string, unknown>[] = [];
	const q = opts.search.trim();
	if (q) {
		and.push({
			_or: ['sample_code', 'nickname', 'short_id'].map((f) => ({ [f]: { _icontains: q } })),
		});
	}
	if (opts.projectScope) and.push(opts.projectScope);
	if (opts.campaignId) and.push({ campaigns: { _some: { campaign_id: { _eq: opts.campaignId } } } });
	return and.length ? { _and: and } : {};
}

// ---- the picker's selection -----------------------------------------------------------------------

// Copies of each sample: a whole number from 1 to MAX_COPIES (a typo of 1000 would print a ream).
export const MAX_COPIES = 100;
export function clampCopies(v: unknown): number {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? Math.min(MAX_COPIES, Math.max(1, n)) : 1;
}

export const slotsPerPage = (t: Pick<LabelTemplate, 'columns' | 'rows' | 'media'>): number =>
	t.media === 'roll' ? 1 : Math.max(1, t.columns * t.rows);

// "Start at": a whole slot from 1 to the number of slots on a page.
export function clampStart(v: unknown, slots: number): number {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? Math.min(Math.max(1, slots), Math.max(1, n)) : 1;
}

// How many labels the pages hold (samples without a code or short id are skipped by the renderer and
// are not counted).
export function countLabels(pages: (LabelSample | null)[][], printable: (s: LabelSample) => boolean): number {
	let n = 0;
	for (const page of pages) for (const s of page) if (s && printable(s)) n++;
	return n;
}

// "12 labels on 1 page · 1 clipped · 2 skipped (invalid)"
export function summaryText(counts: { labels: number; pages: number; clipped: number; invalid: number }): string {
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
	const parts = [`${plural(counts.labels, 'label')} on ${plural(counts.pages, 'page')}`, `${counts.clipped} clipped`, `${counts.invalid} skipped (invalid)`];
	return parts.join(' · ');
}

// ---- templates ------------------------------------------------------------------------------------

export interface BrokenTemplate {
	id: string | null;
	name: string;
	reason: string;
}

// Every row becomes a template, or a broken one with the reason (templateFromRow throws on a corrupt row).
// One corrupt row must not blank the picker.
export function classifyTemplates(rows: Record<string, unknown>[]): { templates: LabelTemplate[]; broken: BrokenTemplate[] } {
	const templates: LabelTemplate[] = [];
	const broken: BrokenTemplate[] = [];
	for (const row of rows) {
		try {
			templates.push(templateFromRow(row));
		} catch (e) {
			broken.push({
				id: typeof row.id === 'string' ? row.id : null,
				name: typeof row.name === 'string' && row.name ? row.name : 'Unnamed template',
				reason: e instanceof Error ? e.message.replace(/^Invalid label template( "[^"]*")?: /, '') : 'unreadable',
			});
		}
	}
	return { templates, broken };
}

// The template shown first: the one remembered in this browser, else the default, else the first one that
// prints (a template with problems is still in the picker, but is never chosen for the user). A remembered id that no longer exists (deleted, or not readable) falls through.
export function pickTemplate(templates: LabelTemplate[], rememberedId: string | null): LabelTemplate | null {
	const printable = templates.filter((t) => t.id && validateTemplate(t).length === 0);
	return (
		printable.find((t) => t.id === rememberedId) ??
		printable.find((t) => t.isDefault) ??
		printable[0] ??
		null
	);
}

// Update and Delete are the owner's, or an admin's (the server enforces the same rule). A host that does
// not know the user yet (null) offers nothing.
export function canEditTemplate(t: Pick<LabelTemplate, 'id' | 'userCreated'>, userId: string | null | undefined, isAdmin: boolean): boolean {
	if (!t.id) return false;
	if (isAdmin) return true;
	return !!userId && t.userCreated === userId;
}

// A fresh draft for "New template": a 4 x 5 A4 sheet, QR on top, code and nickname.
export function blankTemplate(): LabelTemplate {
	return {
		id: null, name: '', description: null, media: 'sheet', pageWidthMm: 210, pageHeightMm: 297, columns: 4, rows: 5,
		labelWidthMm: 52.5, labelHeightMm: 59.4, marginTopMm: 0, marginLeftMm: 0, gapXMm: 0, gapYMm: 0, paddingMm: 2,
		arrangement: 'qr_top', qrSizeMm: null,
		fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm', bold: false }],
		qrFields: [], isDefault: false, userCreated: null, dateCreated: null, userUpdated: null, dateUpdated: null,
	};
}

// A copy of `t` to edit and save as a new row: no id or audit columns, never the default.
export function copyAsNew(t: LabelTemplate, name = `${t.name} copy`): LabelTemplate {
	return {
		...structuredClone(t), id: null, name, isDefault: false,
		userCreated: null, dateCreated: null, userUpdated: null, dateUpdated: null,
	};
}

// A draft (a deep copy, so the editor never changes the picker's template while typing).
export function draftOf(t: LabelTemplate): LabelTemplate {
	return structuredClone(t);
}

const num = (v: unknown): number | null => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// The columns a Lab Member may write (the migration's create/update field list). Everything else
// (is_default, the audit columns, version) is admin-only: sending one fails the whole request with 403.
export const MEMBER_COLUMNS = [
	'name', 'description', 'media', 'page_width_mm', 'page_height_mm', 'columns', 'rows', 'label_width_mm', 'label_height_mm',
	'margin_top_mm', 'margin_left_mm', 'gap_x_mm', 'gap_y_mm', 'padding_mm', 'arrangement', 'qr_size_mm', 'fields', 'qr_fields',
] as const;

// The body of a create or update. Admins also send is_default; everyone else sends the 18 content columns only.
export function templatePayload(t: LabelTemplate, isAdmin: boolean): Record<string, unknown> {
	const fields: LabelField[] = t.fields.map((f) => ({ key: f.key, size: f.size, bold: f.bold === true }));
	const qrFields: FieldKey[] = [...new Set(t.qrFields)];
	const body: Record<string, unknown> = {
		name: t.name.trim(),
		description: t.description?.trim() ? t.description.trim() : null,
		media: t.media,
		page_width_mm: num(t.pageWidthMm),
		page_height_mm: num(t.pageHeightMm),
		columns: num(t.columns),
		rows: num(t.rows),
		label_width_mm: num(t.labelWidthMm),
		label_height_mm: num(t.labelHeightMm),
		margin_top_mm: num(t.marginTopMm) ?? 0,
		margin_left_mm: num(t.marginLeftMm) ?? 0,
		gap_x_mm: num(t.gapXMm) ?? 0,
		gap_y_mm: num(t.gapYMm) ?? 0,
		padding_mm: num(t.paddingMm) ?? 0,
		arrangement: t.arrangement as Arrangement,
		qr_size_mm: num(t.qrSizeMm),
		fields,
		qr_fields: qrFields,
	};
	if (isAdmin) body.is_default = t.isDefault === true;
	return body;
}

// A save that fails on the unique name constraint says so in words.
export function saveErrorText(message: string): string {
	return /unique|duplicate/i.test(message) ? 'A template with that name already exists. Choose another name.' : message;
}

// Field list editing for the editor: pure, so the order logic is tested.
export function moveField(fields: LabelField[], from: number, to: number): LabelField[] {
	if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) return fields;
	const out = fields.slice();
	const [item] = out.splice(from, 1);
	out.splice(to, 0, item);
	return out;
}
