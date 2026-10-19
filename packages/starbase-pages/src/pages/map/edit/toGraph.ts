// Merges a draft into the map's ProcessData (spec §5.2), so the existing groupBatches / buildGraph / ELK path draws it:
// the draft's samples, operations and tests become ghost records (`draft: true`) and its wires become the ids they
// stand for (an operation row's input and output sample, a test's subjects). Nothing is drawn by hand, so a pass
// appended in place joins a stack of passes, a cut with N rows is one container, and the layout needs no new case.
//
// Ids: a new item is `draft:<key>` (an operation row is `draft:<row key>`: each row becomes its own record); an existing
// record keeps its own id. Pure, no Vue, no I/O: what the loader would have read for records that are not in the loaded
// family (a sample picked from the index, an operation being attached) comes in `ctx`.

import type { DraftBody, DraftItem, DraftKey, DraftOperation, DraftSample, DraftTest } from '@d1/ui';
import { KEY_SETTING_FIELDS, FALLBACK_RELATIONS, type RelationDef } from '../model/formSlots';
import type { OpRow, ProcessCategory, ProcessData, Ref, SampleRec, TestRow } from '../model/types';
import { inputSampleOf, itemOf, orderedRows, outputSampleOf, subjectsOf } from './draft';
import { inheritedValues, makerOf, type InheritCtx } from './inherit';

export interface ToGraphCtx extends InheritCtx {
	/** Existing records of the draft that are not in the loaded data: a sample picked from the index, an operation being attached. */
	samples?: Record<string, SampleRec>;
	operations?: Record<string, OpRow>;
	tests?: Record<string, TestRow>;
	/** The relation fields of the two forms (their collections); the fallback lists when left out. */
	relations?: { operation: RelationDef[]; test: RelationDef[] };
	/** The name of a method and its process category, by method id. */
	methods?: Record<string, { name: string; category: ProcessCategory }>;
	/** The name and category of a test type, by its value. */
	testTypes?: Record<string, { name?: string; category: TestRow['category'] }>;
	/** The code or name a picked record is shown with, by `<collection>:<id>`; the id when unknown. */
	label?: (collection: string, id: string) => string | undefined;
}

/** The record id a new draft item is drawn with. */
export const draftId = (key: DraftKey): string => `draft:${key}`;
/** The draft key behind a record id made by `draftId`; null for a recorded record. */
export const draftKeyOf = (id: string): DraftKey | null => (id.startsWith('draft:') ? id.slice('draft:'.length) : null);

/** The loaded data of a blank canvas: nothing, focused on nothing. */
export function emptyData(): ProcessData {
	return {
		focus: { collection: 'physical_samples', id: '', code: '', kind: 'sample' },
		samples: [],
		operations: [],
		tests: [],
		lineage: [],
		stock: [],
		hidden: { ancestors: false, descendants: false, events: false, stock: false },
		truncated: false,
	};
}

const SETTING_FIELDS = new Set(Object.values(KEY_SETTING_FIELDS).flatMap((defs) => defs.flatMap((d) => d.fields.map((f) => f.field))));
const SAMPLE_FACTS: { label: string; field: string; unit: string }[] = [
	{ label: 'Mass', field: 'mass_grams', unit: 'g' },
	{ label: 'Diameter', field: 'diameter_mm', unit: 'mm' },
	{ label: 'Thickness', field: 'thickness_mm', unit: 'mm' },
	{ label: 'Length', field: 'length_mm', unit: 'mm' },
];

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const idText = (v: unknown): string | null => (typeof v === 'string' && v !== '') || typeof v === 'number' ? String(v) : null;
const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/** Where the draft's new operations start in the numbering (after Create's order); recorded steps still come first on the same date, see stepOrder. */
const DRAFT_SEQUENCE = 1_000_000;

/** The date a record is drawn and ordered by: the day it happened, else (planned) the day it is meant to happen. */
function dateOf(item: DraftOperation | DraftTest, values: Record<string, unknown>): string | null {
	const own = text(values[item.kind === 'operation' ? 'operation_date' : 'session_date']);
	return own ?? (item.workState === 'planned' ? text(values.planned_date) : null);
}

function relationsOf(values: Record<string, unknown>, defs: RelationDef[], ctx: ToGraphCtx): Record<string, Ref | null> {
	const out: Record<string, Ref | null> = {};
	for (const d of defs) {
		const id = idText(values[d.field]);
		if (id) out[d.field] = { collection: d.collection, id, code: ctx.label?.(d.collection, id) ?? id };
	}
	return out;
}

const settingsOf = (values: Record<string, unknown>): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const f of SETTING_FIELDS) if (values[f] !== null && values[f] !== undefined && values[f] !== '') out[f] = values[f];
	return out;
};

export function toGraph(data: ProcessData | null, body: DraftBody, ctx: ToGraphCtx = {}): ProcessData {
	const base = data ?? emptyData();
	const have = new Set(base.samples.map((s) => s.id));
	const samples: SampleRec[] = [...base.samples];
	const operations: OpRow[] = [...base.operations];
	const tests: TestRow[] = [...base.tests];
	const defs = ctx.relations ?? FALLBACK_RELATIONS;

	/** The record id a sample item stands for. */
	const sampleRecord = (item: DraftItem): string => (item.existing ? item.existing.id : draftId(item.key));
	const recordOf = (key: DraftKey | null): string | null => {
		const item = key ? itemOf(body, key) : undefined;
		return item?.kind === 'sample' ? sampleRecord(item) : null;
	};
	const project = (values: Record<string, unknown>) => idText(values.project_id) ?? body.projectId;

	// Samples.
	for (const item of body.items) {
		if (item.kind !== 'sample') continue;
		const id = sampleRecord(item);
		if (have.has(id)) continue;
		have.add(id);
		samples.push(item.existing ? existingSample(item, id, ctx) : newSample(item, id));
	}

	function existingSample(item: DraftSample, id: string, c: ToGraphCtx): SampleRec {
		return c.samples?.[id] ?? { id, code: c.label?.('physical_samples', id) ?? id, nickname: null, form: null, status: null, projectId: null, materialRef: null, facts: {} };
	}

	function newSample(item: DraftSample, id: string): SampleRec {
		const own = item.values;
		const all = { ...inheritedValues(body, item.key, ctx).values, ...own };
		const material = idText(all.material_id);
		const facts: Record<string, string> = {};
		for (const { label, field, unit } of SAMPLE_FACTS) {
			const n = num(all[field]);
			if (n !== null) facts[label] = `${n} ${unit}`;
		}
		const code = text(own.sample_code);
		const maker = makerOf(body, item.key);
		return {
			id,
			// {seq} is the number the database gives at Create: "?" until then, as on the Register a sample page.
			code: code ? code.replace(/^\{seq\}/, '?') : 'New sample',
			nickname: text(all.nickname),
			form: text(all.form),
			status: maker?.op.workState === 'planned' ? 'planned' : null,
			projectId: project(own),
			materialRef: material ? { collection: 'materials', id: material, code: ctx.alloyCode?.(material) ?? ctx.label?.('materials', material) ?? material } : null,
			facts,
			draft: true,
		};
	}

	// Operations: one record per row.
	// Numbered in the order Create writes them (d1-build's orderOperations): the wires first, then the order of the draft.
	const position = new Map(orderedRows(body).map((r, i) => [r.rowKey, i]));
	for (const item of body.items) {
		if (item.kind === 'operation') {
			item.rows.forEach((row, i) => {
				const input = recordOf(inputSampleOf(body, { key: item.key, row: i }));
				const output = recordOf(outputSampleOf(body, item.key, i));
				if (item.existing) {
					attached(item, input, output, i);
					return;
				}
				const v = item.values;
				const method = idText(v.method_id);
				const planned = item.workState === 'planned';
				operations.push({
					id: draftId(row.key),
					code: '',
					methodId: method ?? '',
					methodName: (method && ctx.methods?.[method]?.name) || '',
					category: (method && ctx.methods?.[method]?.category) || null,
					date: dateOf(item, v),
					sequence: DRAFT_SEQUENCE + (position.get(row.key) ?? 0),
					status: null,
					sampleId: input,
					outputSampleId: output,
					equipmentId: idText(v.equipment_id),
					recipeKey: null,
					// The rows of one new container are tied by a batch at Create (E9), so they are one container here too.
					batchId: item.rows.length > 1 ? draftId(item.key) : null,
					sourceRunUid: null,
					powderBatch: null,
					relations: relationsOf(v, defs.operation, ctx),
					settings: settingsOf(v),
					projectId: project(v),
					...(planned ? { workState: 'planned' as const, plannedDate: text(v.planned_date) } : {}),
					draft: true,
				});
			});
		} else if (item.kind === 'test') {
			if (item.existing) continue;
			const v = item.values;
			const type = text(v.test_type);
			const known = type ? ctx.testTypes?.[type] : undefined;
			const planned = item.workState === 'planned';
			tests.push({
				id: draftId(item.key),
				code: '',
				testType: type ? (known?.name ?? type) : null,
				category: known?.category ?? null,
				date: dateOf(item, v),
				status: null,
				subjectSampleIds: subjectsOf(body, item.key).map((k) => recordOf(k)).filter((id): id is string => !!id),
				equipmentId: idText(v.equipment_id),
				batchId: null,
				relations: relationsOf(v, defs.test, ctx),
				settings: settingsOf(v),
				projectId: project(v),
				...(planned ? { workState: 'planned' as const, plannedDate: text(v.planned_date) } : {}),
				draft: true,
			});
		}
	}

	/** An existing operation being attached: its record with the sample the draft wires into it. */
	function attached(item: DraftOperation, input: string | null, output: string | null, row: number) {
		if (!item.attach || row > 0 || !item.existing) return;
		const id = item.existing.id;
		const at = operations.findIndex((o) => o.id === id);
		const loaded = at >= 0 ? operations[at] : ctx.operations?.[id];
		const record: OpRow = {
			...(loaded ?? stubOperation(id, ctx)),
			sampleId: input,
			outputSampleId: output ?? loaded?.outputSampleId ?? null,
			attaching: true,
		};
		if (at >= 0) operations[at] = record;
		else operations.push(record);
		// The sample it made: the map has not loaded it when the operation came from the database. Drawn as the record it is (not a draft card);
		// one the caller cannot read stays the stub card buildGraph makes for an output nobody loaded. Attaching writes only the operation's input.
		const made = record.outputSampleId;
		if (made && !have.has(made) && ctx.samples?.[made]) {
			have.add(made);
			samples.push(ctx.samples[made]);
		}
	}

	markRemoving(body, samples, operations, tests);

	return { ...base, samples, operations, tests, ...(data ? {} : { focus: focusOf(samples, base) }) };
}

/**
 * Existing planned records the draft deletes at Create (`remove`) are drawn struck through: their records are marked `removing`, in
 * place in the lists. The planned output of a removed operation goes with it (d1-build deletes it too), so it is marked as well.
 */
function markRemoving(body: DraftBody, samples: SampleRec[], operations: OpRow[], tests: TestRow[]): void {
	const mark = <T extends { id: string; removing?: true }>(list: T[], id: string): T | undefined => {
		const at = list.findIndex((r) => r.id === id);
		if (at < 0) return undefined;
		list[at] = { ...list[at], removing: true };
		return list[at];
	};
	for (const item of body.items) {
		if (!item.remove || !item.existing) continue;
		const id = item.existing.id;
		if (item.kind === 'sample') mark(samples, id);
		else if (item.kind === 'test') mark(tests, id);
		else {
			const op = mark(operations, id);
			const out = op?.outputSampleId;
			const made = out ? samples.find((s) => s.id === out) : undefined;
			if (made && made.status === 'planned') mark(samples, made.id);
		}
	}
}

function stubOperation(id: string, ctx: ToGraphCtx): OpRow {
	return {
		id,
		code: ctx.label?.('manufacturing_operations', id) ?? id,
		methodId: '',
		methodName: '',
		category: null,
		date: null,
		sequence: null,
		status: null,
		sampleId: null,
		outputSampleId: null,
		equipmentId: null,
		recipeKey: null,
		batchId: null,
		sourceRunUid: null,
		powderBatch: null,
		relations: {},
		settings: {},
		projectId: null,
	};
}

/** A blank canvas has no focus record: the first sample drawn stands in, so the map has something to hold on to. */
function focusOf(samples: SampleRec[], base: ProcessData): ProcessData['focus'] {
	const first = samples[0];
	return first ? { collection: 'physical_samples', id: first.id, code: first.code, kind: 'sample' } : base.focus;
}
