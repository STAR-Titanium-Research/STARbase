// Checks of a draft (spec E5 and E13): what is missing before Create, in the lab's words. Run on the client for the
// canvas (badges, the Checks section, the Create button) and again by `d1-build` when it creates; useDraft merges the two.
//
// - Blocking: what the database refuses (an operation with no method, one with neither a sample in nor out, a test with
//   no type or no sample, a new sample whose code cannot be made), a record found gone or no longer attachable on a
//   re-read, and, for done records only, the fields the form marks required.
// - Warnings: useful but optional fields (no machine, no planned date), and records changed since they were added.
// Planned records need only their structure: the method and the wiring, the test type for a test.
//
// Pure, no Vue: `ctx` carries the field definitions and the existing records as they were last read.

import type { Check, DraftBody, DraftItem, DraftKey, DraftOperation, DraftSample } from '@d1/ui';
import { inputSampleOf, itemOf, outputSampleOf, subjectsOf, wiresOutOf } from './draft';
import { inheritedValues, makerOf, sampleCodeFor, type InheritCtx } from './inherit';

export type CheckCollection = 'physical_samples' | 'manufacturing_operations' | 'test_sessions';

/** The part of a Directus field definition the checks read. */
export interface FieldDef {
	field: string;
	required: boolean;
	label?: string;
	/** Hidden and read-only fields are never asked for. */
	hidden?: boolean;
	readonly?: boolean;
}

/** An existing record of the draft as it was read again. */
export interface LoadedRecord {
	version: number;
	values: Record<string, unknown>;
	/** The operation has an input sample already (it cannot be attached any more). Taken from `values.sample_id` when left out. */
	hasInput?: boolean;
}

export interface CheckCtx extends InheritCtx {
	/** Field definitions by collection (`useFieldDefs`); a collection with none has no required fields to ask for. */
	fields?: Partial<Record<CheckCollection, FieldDef[]>>;
	/** Existing records re-read, by `<collection>:<id>`. `null` = gone or no longer readable; a key that is absent = not read (yet). */
	records?: Record<string, LoadedRecord | null>;
}

export const recordKey = (collection: CheckCollection, id: string) => `${collection}:${id}`;

const COLLECTION: Record<DraftItem['kind'], CheckCollection> = {
	sample: 'physical_samples',
	operation: 'manufacturing_operations',
	test: 'test_sessions',
};
export const collectionOf = (item: DraftItem): CheckCollection => COLLECTION[item.kind];

const WORDS: Record<DraftItem['kind'], string> = { sample: 'sample', operation: 'operation', test: 'test' };

/** Fields the draft fills in by itself (wires, the draft's project and campaign, the server's defaults, the code), never asked for. */
const BY_THE_DRAFT = new Set([
	'sample_id', 'output_sample_id', 'operation_id', 'session_id', 'sample_code', 'work_state', 'owner_person_id', 'owner', 'batch_id',
	'done_by_person_id', 'done_at', 'operation_sequence', 'pass_code', 'test_code',
]);

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const block = (key: DraftKey, text: string, field?: string): Check => ({ key, ...(field ? { field } : {}), level: 'block', text });
const warn = (key: DraftKey, text: string, field?: string): Check => ({ key, ...(field ? { field } : {}), level: 'warn', text });

function loadedOf(item: DraftItem, ctx: CheckCtx): LoadedRecord | null | undefined {
	return item.existing ? ctx.records?.[recordKey(collectionOf(item), item.existing.id)] : undefined;
}

/** The fields of an item as they will stand: the loaded record, then the draft's changes. */
function merged(item: DraftItem, ctx: CheckCtx): Record<string, unknown> {
	return { ...(loadedOf(item, ctx)?.values ?? {}), ...item.values };
}

/** A record that exists is asked for a field only once its record was read, or the draft sets that field. */
const known = (item: DraftItem, field: string, ctx: CheckCtx): boolean => !item.existing || loadedOf(item, ctx) !== undefined || field in item.values;

const labelOf = (defs: FieldDef[] | undefined, field: string) => defs?.find((d) => d.field === field)?.label ?? field.replace(/_/g, ' ');

/** The required fields (from the field definitions) that have no value, for a record that is done. */
function missingRequired(item: DraftItem, body: DraftBody, ctx: CheckCtx, values: Record<string, unknown>): Check[] {
	const defs = ctx.fields?.[collectionOf(item)];
	if (!defs) return [];
	const out: Check[] = [];
	for (const d of defs) {
		if (!d.required || d.hidden || d.readonly || BY_THE_DRAFT.has(d.field)) continue;
		if (d.field === 'project_id' && body.projectId) continue;
		if (d.field === 'campaign_id' && body.campaignId) continue;
		// A record that exists is only asked again for what this draft changes.
		if (item.existing && !(d.field in item.values)) continue;
		if (empty(values[d.field])) out.push(block(item.key, `Fill in ${labelOf(defs, d.field)}: ${item.kind === 'sample' ? 'a new sample' : `a done ${WORDS[item.kind]}`} needs it.`, d.field));
	}
	return out;
}

/** What E13 asks of an existing record that was read again. */
function staleChecks(item: DraftItem, ctx: CheckCtx): Check[] {
	if (!item.existing) return [];
	const loaded = loadedOf(item, ctx);
	if (loaded === undefined) return [];
	if (loaded === null) {
		return [block(item.key, `This ${WORDS[item.kind]} is gone, or you can no longer see it. Take it off the canvas.`)];
	}
	const out: Check[] = [];
	if (item.kind === 'operation' && item.attach && (loaded.hasInput ?? !empty(loaded.values.sample_id))) {
		out.push(block(item.key, 'This operation has a sample going in now, so it can no longer be attached.'));
	}
	if (loaded.version !== item.existing.version) out.push(warn(item.key, 'Changed since you added it. Review it before you create.'));
	return out;
}

function sampleChecks(item: DraftSample, body: DraftBody, ctx: CheckCtx): Check[] {
	if (item.existing || item.remove) return [];
	const out: Check[] = [];
	const inherited = inheritedValues(body, item.key, ctx).values;
	const all = { ...inherited, ...item.values };
	// The code is `{seq}-alloy-method-date`: without a material and a method it cannot be made.
	if (empty(all.material_id)) out.push(block(item.key, "Choose the material: it is part of the sample's code.", 'material_id'));
	if (empty(all.primary_method_id)) out.push(block(item.key, "Choose the method: it is part of the sample's code.", 'primary_method_id'));
	else if (!empty(all.material_id) && ctx.alloyCode && ctx.methodCode && !sampleCodeFor(body, item.key, ctx)) {
		out.push(block(item.key, "The sample's code cannot be made: the material or the method has no code.", 'sample_code'));
	}
	// A sample that is already active (no operation makes it, or the operation that makes it is done) is a full record.
	const maker = makerOf(body, item.key);
	if (!maker || maker.op.workState === 'done') out.push(...missingRequired(item, body, ctx, all));
	return out;
}

function operationChecks(item: DraftOperation, body: DraftBody, ctx: CheckCtx): Check[] {
	if (item.remove) return removeChecks(item, ctx);
	const out: Check[] = [];
	const values = merged(item, ctx);
	if (empty(values.method_id) && known(item, 'method_id', ctx)) out.push(block(item.key, 'Choose the method of this operation.', 'method_id'));
	item.rows.forEach((_, row) => {
		const label = item.rows.length > 1 ? `Piece ${row + 1} of this operation` : 'This operation';
		const input = inputSampleOf(body, { key: item.key, row });
		const output = outputSampleOf(body, item.key, row);
		const continues = wiresOutOf(body, item.key, row).length > 0;
		if (!input && !output && !(item.existing && !item.attach)) {
			out.push(block(item.key, `${label} needs a sample going in or coming out: wire a sample to its socket.`));
		} else if (item.rows.length > 1 && !output && !continues) {
			out.push(warn(item.key, `${label} makes no new sample yet: add a sample to its output socket.`));
		}
	});
	const planned = item.workState === 'planned';
	if (!item.existing || item.attach) {
		if (!item.existing && planned && empty(values.planned_date)) out.push(warn(item.key, 'No planned date yet.', 'planned_date'));
		if (empty(values.equipment_id)) out.push(warn(item.key, 'No machine yet.', 'equipment_id'));
	}
	if (item.workState === 'done') out.push(...missingRequired(item, body, ctx, values));
	return out;
}

function testChecks(item: DraftItem & { kind: 'test' }, body: DraftBody, ctx: CheckCtx): Check[] {
	if (item.remove) return removeChecks(item, ctx);
	const out: Check[] = [];
	const values = merged(item, ctx);
	if (empty(values.test_type) && known(item, 'test_type', ctx)) out.push(block(item.key, 'Choose the type of this test.', 'test_type'));
	if (!item.existing && subjectsOf(body, item.key).length === 0) {
		out.push(block(item.key, 'This test needs the sample it is done on: wire a sample to its socket.'));
	}
	if (!item.existing) {
		if (item.workState === 'planned' && empty(values.planned_date)) out.push(warn(item.key, 'No planned date yet.', 'planned_date'));
		if (empty(values.equipment_id)) out.push(warn(item.key, 'No machine yet.', 'equipment_id'));
	}
	if (item.workState === 'done') out.push(...missingRequired(item, body, ctx, values));
	return out;
}

/** E18: only planned records are deleted from the map. */
function removeChecks(item: DraftItem, ctx: CheckCtx): Check[] {
	const loaded = loadedOf(item, ctx);
	if (loaded && loaded.values.work_state === 'done') {
		return [block(item.key, `A done ${WORDS[item.kind]} is never deleted from the map.`)];
	}
	return [];
}

/** Every check of a draft, blocking first, each group in the order of the cards. */
export function checks(body: DraftBody, ctx: CheckCtx = {}): Check[] {
	const out: Check[] = [];
	for (const item of body.items) {
		out.push(...staleChecks(item, ctx));
		if (item.kind === 'sample') out.push(...sampleChecks(item, body, ctx));
		else if (item.kind === 'operation') out.push(...operationChecks(item, body, ctx));
		else out.push(...testChecks(item, body, ctx));
	}
	// A card that is gone cannot be edited: its other checks would only be noise.
	const gone = new Set(out.filter((c) => c.level === 'block' && /is gone/.test(c.text)).map((c) => c.key));
	const rest = out.filter((c) => !gone.has(c.key) || /is gone/.test(c.text));
	return [...rest.filter((c) => c.level === 'block'), ...rest.filter((c) => c.level === 'warn')];
}

export const blocking = (list: Check[]): Check[] => list.filter((c) => c.level === 'block');
export const warnings = (list: Check[]): Check[] => list.filter((c) => c.level === 'warn');

/** The checks of one card, for its badge. */
export const checksFor = (list: Check[], key: DraftKey): Check[] => list.filter((c) => c.key === key);

/** "3 things missing" on the Create button; '' when nothing blocks. */
export function missingText(list: Check[]): string {
	const n = blocking(list).length;
	return n ? `${n} ${n === 1 ? 'thing' : 'things'} missing` : '';
}

/** Two lists of checks as one, without the same message twice (the client's and the server's last answer). */
export function mergeChecks(...lists: Check[][]): Check[] {
	const seen = new Set<string>();
	const out: Check[] = [];
	for (const c of lists.flat()) {
		const id = `${c.key}|${c.field ?? ''}|${c.level}|${c.text}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(c);
	}
	return [...out.filter((c) => c.level === 'block'), ...out.filter((c) => c.level === 'warn')];
}

/** True when the check belongs to a card that is in the body (a server check of an older draft may name one that is not). */
export const onCanvas = (body: DraftBody, check: Check): boolean => !!itemOf(body, check.key);
