// Attach from the database (redesign R8, as scoped by the maintainer on 2026-10-19): the recorded operations that can be given an input
// sample, and what is said about the ones that cannot be chosen. An operation can be attached when it has NO input sample (planned or
// done): the database requires an input or an output, so every such operation made a sample whose input was never recorded. Attaching it
// sets `operation.sample_id` only; the genealogy trigger writes the lineage (input -> the sample it made) and nothing else changes.
//
// Pure, no Vue, no I/O: the query the picker asks, the rows it gets back, the reason a row is greyed. useEditCatalog.ts reads, the
// picker draws.

import { operationLabel, type DraftBody } from '@d1/ui';
import type { WorkState } from './draft';
import { RELATIONS } from '../model/rows';
import { SAMPLE_STILL_PLANNED } from './checks';

/** How many operations one page of the picker lists. */
export const ORPHAN_PAGE = 20;

/** What the picker reads of each operation (db/migrations: manufacturing_operations, 189 for `work_state` and `planned_date`). */
export const ORPHAN_FIELDS = [
	'operation_id',
	'pass_code',
	'operation_sequence',
	'operation_date',
	'planned_date',
	'work_state',
	'version',
	'method_id.method_id',
	'method_id.method_name',
	'owner_person_id.full_name',
	'output_sample_id.sample_id',
	'output_sample_id.sample_code',
];

/**
 * The query for the operations with no input sample whose pass code, method name or output sample's code contain every word of `query`,
 * newest first. `limit` is one more than the page, so the picker can tell whether there is another page without a count.
 */
export function orphanParams(query: string, offset = 0, limit = ORPHAN_PAGE + 1): Record<string, unknown> {
	const words = query.split(/\s+/).filter(Boolean);
	const filter = {
		_and: [
			{ sample_id: { _null: true } },
			...words.map((w) => ({
				_or: [{ pass_code: { _icontains: w } }, { method_id: { method_name: { _icontains: w } } }, { output_sample_id: { sample_code: { _icontains: w } } }],
			})),
		],
	};
	return { fields: ORPHAN_FIELDS, filter: JSON.stringify(filter), sort: ['-created_at', '-operation_id'], limit, offset };
}

export interface OrphanRow {
	id: string;
	version: number;
	/** The pass code, else what `operationLabel` makes of the row. */
	code: string;
	method: string;
	/** The day it happened, else (planned) the day it is meant to. */
	date: string | null;
	workState: WorkState;
	owner: string | null;
	/** The sample it made (an operation needs an input or an output, so an operation with no input has one). Absent when the caller cannot read it. */
	output: { id: string; code: string } | null;
	/** The samples the sample it made already comes from, as far as the caller can read them (the catalog fills it in). */
	origins: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const rel = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A row of the answer as the picker draws it; null when it has no id or no version (it could not be attached with one). */
export function orphanRowOf(r: Record<string, unknown>): OrphanRow | null {
	const id = text(r.operation_id);
	const version = Number(r.version);
	if (!id || !Number.isFinite(version)) return null;
	const out = rel(r.output_sample_id);
	const outId = text(out?.sample_id);
	const output = outId ? { id: outId, code: text(out?.sample_code) ?? 'a sample' } : null;
	const seq = Number(r.operation_sequence);
	return {
		id,
		version,
		code: operationLabel({ pass_code: text(r.pass_code), operation_sequence: Number.isFinite(seq) && r.operation_sequence !== null ? seq : null }, output?.code ?? null),
		method: text(rel(r.method_id)?.method_name) ?? 'No method',
		date: (text(r.operation_date) ?? text(r.planned_date))?.slice(0, 10) ?? null,
		// Without the field (a database that has no planned work) every record is done.
		workState: r.work_state === 'planned' ? 'planned' : 'done',
		owner: text(rel(r.owner_person_id)?.full_name),
		output,
		origins: [],
	};
}

export const ON_CANVAS = 'Already on the canvas.';
export const ALREADY_ATTACHED = 'Already attached in this draft.';

/** What the picker knows about the place the operation would go. */
export interface AttachSite {
	body: DraftBody;
	/** The record ids of the operations drawn on the canvas (the loaded map and the draft's own). */
	onCanvas: ReadonlySet<string>;
	/** The sample the operation would take in is planned: done work has nothing to work on yet. False when attaching floats (no sample yet). */
	samplePlanned?: boolean;
	/** The ids of the samples the target comes from, as far as the map has loaded them (not the target itself): an operation that makes one of them would close a circle. */
	ancestors?: ReadonlySet<string>;
	/** The record id of the sample the operation would take in; undefined when it floats. */
	target?: string;
}

/** Why this operation cannot be attached here, in the words of the lab, or null when it can. */
export function orphanReason(row: OrphanRow, site: AttachSite): string | null {
	if (site.body.items.some((i) => i.kind === 'operation' && i.existing?.id === row.id)) {
		return site.body.items.some((i) => i.kind === 'operation' && i.existing?.id === row.id && i.attach) ? ALREADY_ATTACHED : ON_CANVAS;
	}
	if (site.onCanvas.has(row.id)) return ON_CANVAS;
	if (row.workState === 'done' && site.samplePlanned) return SAMPLE_STILL_PLANNED;
	if (row.output && site.target && row.output.id === site.target) return `It makes ${row.output.code}: a sample cannot be an input of the operation that made it.`;
	// It made a sample that already comes from another one: attaching would give it a second origin (joining two processes, not done from the map).
	if (row.output && row.origins.some((p) => p !== site.target)) return `It made ${row.output.code}, which already comes from another sample: attaching would give it a second origin.`;
	if (row.output && site.ancestors?.has(row.output.id)) return `It makes ${row.output.code}, which this sample comes from: that would run in a circle.`;
	return null;
}

/**
 * An operation read with its relations expanded (`method_id.method_name`, the card's fields), as the record a form and the checks work
 * with: every relation back to its key. A value that is not an expanded relation is left as it is.
 */
export function collapseRelations(row: Record<string, unknown>): Record<string, unknown> {
	const keys: Record<string, string> = { method_id: 'method_id', ...Object.fromEntries(Object.entries(RELATIONS).map(([field, spec]) => [field, spec.id])) };
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) out[k] = keys[k] && rel(v) ? (rel(v)![keys[k]] ?? null) : v;
	return out;
}
