// "Life of a sample": the GET /d1-trace/sample/:id response flattened into one ordered list of
// steps, oldest first: raw stock -> ancestors -> this sample -> operations and tests by date ->
// descendants. The page lays the list out as a horizontal strip (or a vertical list when narrow).
//
// Everything in the response was already filtered through the caller's permissions by the endpoint:
// what they may not read is only flagged (`hidden`), and shows as a "some records hidden" marker. d1-trace sends booleans now
// (a count would tell a reader how many records they cannot see, which for a Restricted record is information); this file
// accepts a number as well, so it works against an older d1-trace.

import { formatDate } from './format';
import { hasPassCode, operationLabel } from './operationLabel';
import { recordRoute } from './recordRoute';

export interface TraceResponse {
	sample: { sample_id: string; sample_code: string | null; form: string | null };
	stock_origins: {
		lot_id: string;
		lot_code: string | null;
		stock_type: string | null;
		supplier_name: string | null;
		mass_used_grams: number | null;
		via_sample_id: string;
		via_sample_code: string | null;
		depth: number;
		through_hidden: boolean;
	}[];
	ancestors: TraceRelative[];
	descendants: TraceRelative[];
	events: {
		type: 'manufacturing_operation' | 'test_session';
		collection: string;
		id: string;
		date: string | null;
		label: string | null;
		sequence: number | null;
		status: string | null;
	}[];
	hidden: { stock_origins: number | boolean; ancestors: number | boolean; events: number | boolean; descendants: number | boolean };
	truncated: Record<string, boolean>;
}

export interface TraceRelative {
	depth: number;
	sample_id: string;
	sample_code: string | null;
	form: string | null;
	relationship_type: string | null;
	fraction: number | null;
	through_hidden: boolean;
}

export type LifeKind = 'stock' | 'ancestor' | 'self' | 'operation' | 'test' | 'descendant' | 'hidden';

export interface LifeItem {
	key: string;
	kind: LifeKind;
	label: string;
	/** Second line: form, relationship, status ... */
	sub: string;
	date: string | null;
	/** App route of the record; null for a hidden marker and for this sample. */
	to: string | null;
	/** The label is a code a person could type or scan (sample, lot or pass code), not a description: set in monospace. */
	isCode: boolean;
	/** Reached only through a sample the user cannot see. */
	throughHidden: boolean;
	/** The operation's step (`operation_sequence`); null for everything else. */
	sequence?: number | null;
}

// The marker text: never a number, whatever the response carries.
export const HIDDEN_MARKER_TEXT = 'some records hidden';
export function hiddenText(_hidden?: number | boolean): string {
	return HIDDEN_MARKER_TEXT;
}

function relation(n: TraceRelative): string {
	const parts: string[] = [];
	if (n.relationship_type) parts.push(String(n.relationship_type).replace(/_/g, ' '));
	if (n.fraction !== null && n.fraction !== undefined) parts.push(`fraction ${n.fraction}`);
	return parts.join(', ');
}

const join = (parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join(' · ');

function hiddenMarker(group: string, hidden: number | boolean): LifeItem[] {
	if (!hidden) return [];
	return [
		{ key: `hidden-${group}`, kind: 'hidden', label: hiddenText(hidden), sub: '', date: null, to: null, throughHidden: false, isCode: false },
	];
}

export function buildLife(trace: TraceResponse): LifeItem[] {
	const items: LifeItem[] = [];

	for (const s of trace.stock_origins) {
		items.push({
			key: `stock-${s.lot_id}|${s.via_sample_id}`,
			kind: 'stock',
			label: s.lot_code || 'Stock lot',
			isCode: !!s.lot_code,
			sub: join([
				s.stock_type,
				s.supplier_name,
				s.mass_used_grams !== null && s.mass_used_grams !== undefined && `${s.mass_used_grams} g used`,
				s.via_sample_code && s.depth > 0 && `via ${s.via_sample_code}`,
			]),
			date: null,
			to: recordRoute('raw_stock_lots', s.lot_id),
			throughHidden: s.through_hidden,
		});
	}
	items.push(...hiddenMarker('stock_origins', trace.hidden.stock_origins));

	// Oldest generation first, so the strip reads stock -> grandparent -> parent -> this sample.
	const ancestors = [...trace.ancestors].sort((a, b) => b.depth - a.depth);
	items.push(...hiddenMarker('ancestors', trace.hidden.ancestors));
	for (const a of ancestors) {
		items.push({
			key: `ancestor-${a.sample_id}`,
			kind: 'ancestor',
			label: a.sample_code || 'Sample',
			isCode: !!a.sample_code,
			sub: join([a.form, relation(a)]),
			date: null,
			to: recordRoute('physical_samples', a.sample_id),
			throughHidden: a.through_hidden,
		});
	}

	items.push({
		key: 'self',
		kind: 'self',
		label: trace.sample.sample_code ?? 'This sample',
		isCode: !!trace.sample.sample_code,
		sub: trace.sample.form ?? '',
		date: null,
		to: null,
		throughHidden: false,
	});

	// The endpoint sends events oldest first, undated last.
	for (const e of trace.events) {
		const isTest = e.type === 'test_session';
		items.push({
			key: `${e.type}-${e.id}`,
			kind: isTest ? 'test' : 'operation',
			isCode: !isTest && hasPassCode({ pass_code: e.label }),
			label: isTest ? (e.label ?? '—') : operationLabel({ pass_code: e.label, operation_sequence: e.sequence }, trace.sample.sample_code),
			// An operation without a pass code is already labelled with its step.
			sub: isTest ? (e.status ?? '') : hasPassCode({ pass_code: e.label }) && e.sequence !== null && e.sequence !== undefined ? `#${e.sequence}` : '',
			date: e.date,
			to: recordRoute(e.collection, e.id),
			throughHidden: false,
			sequence: isTest ? null : (e.sequence ?? null),
		});
	}
	items.push(...hiddenMarker('events', trace.hidden.events));

	for (const d of [...trace.descendants].sort((a, b) => a.depth - b.depth)) {
		items.push({
			key: `descendant-${d.sample_id}`,
			kind: 'descendant',
			label: d.sample_code || 'Sample',
			isCode: !!d.sample_code,
			sub: join([d.form, relation(d)]),
			date: null,
			to: recordRoute('physical_samples', d.sample_id),
			throughHidden: d.through_hidden,
		});
	}
	items.push(...hiddenMarker('descendants', trace.hidden.descendants));

	return items;
}

// Each list is capped at 500 by the endpoint: the nearest relatives, and the newest events.
const TRUNCATED_TEXT: Record<string, string> = {
	ancestors: 'Very long history: only the 500 nearest ancestors are shown.',
	descendants: 'Very long history: only the 500 nearest descendants are shown.',
	stock_origins: 'Very long history: only the 500 nearest raw stock lots are shown.',
	events: 'Very long history: only the newest 500 operations and tests are shown.',
};

export function truncatedNotes(trace: Pick<TraceResponse, 'truncated'>): string[] {
	return Object.keys(trace.truncated ?? {}).map(
		(k) => TRUNCATED_TEXT[k] ?? `Very long history: ${k.replace('_', ' ')} is cut short.`,
	);
}

// A sample can have 20-30 operations and tests, often several on one day: one node each made the
// strip scroll for screens. The strip shows each day as one node instead, with a small chip per
// record; the lineage (stock, parents, this sample, children) keeps a node per record.

export interface LifeDay {
	type: 'day';
	key: string;
	/** "31 Mar 2023", or "Undated". */
	dayText: string;
	/** Operations by step, then tests, in the order the endpoint sent them. */
	items: LifeItem[];
	operations: number;
	tests: number;
}

export type LifeStep = { type: 'item'; key: string; item: LifeItem } | LifeDay;

const isEvent = (i: LifeItem): boolean => i.kind === 'operation' || i.kind === 'test';
const bySequence = (a: LifeItem, b: LifeItem): number => (a.sequence ?? Infinity) - (b.sequence ?? Infinity);

/** Folds the operations and tests of `buildLife` into one step per calendar day (undated ones into one last step). */
export function groupLife(items: LifeItem[]): LifeStep[] {
	const steps: LifeStep[] = [];
	let day: LifeDay | null = null;
	for (const item of items) {
		if (!isEvent(item)) {
			day = null;
			steps.push({ type: 'item', key: item.key, item });
			continue;
		}
		const dayText = formatDate(item.date, 'Undated');
		if (!day || day.dayText !== dayText) {
			day = { type: 'day', key: `day-${dayText}`, dayText, items: [], operations: 0, tests: 0 };
			steps.push(day);
		}
		day.items.push(item);
		if (item.kind === 'test') day.tests++;
		else day.operations++;
	}
	for (const s of steps) {
		if (s.type !== 'day') continue;
		const ops = s.items.filter((i) => i.kind === 'operation').sort(bySequence);
		s.items = [...ops, ...s.items.filter((i) => i.kind === 'test')];
	}
	return steps;
}

const count = (n: number, one: string, many: string): string => (n ? `${n} ${n === 1 ? one : many}` : '');

/** "26 operations · 2 tests". */
export function daySummary(day: Pick<LifeDay, 'operations' | 'tests'>): string {
	return join([count(day.operations, 'operation', 'operations'), count(day.tests, 'test', 'tests')]);
}

/** A record's chip in a day: an operation's step (`#17`), else its label; a test's type. */
export function chipText(item: LifeItem): string {
	if (item.kind === 'operation' && item.sequence !== null && item.sequence !== undefined) return `#${item.sequence}`;
	return item.label;
}

/** The chip's tooltip: the full label, with a test's status or a coded operation's step. */
export function chipTitle(item: LifeItem): string {
	if (item.kind === 'test') return join([item.label, item.sub]);
	const step = item.isCode && item.sequence !== null && item.sequence !== undefined ? `step ${item.sequence}` : '';
	return join([item.label, step]);
}
