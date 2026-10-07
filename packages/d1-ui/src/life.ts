// "Life of a sample": the GET /d1-trace/sample/:id response flattened into one ordered list of
// steps, oldest first: raw stock -> ancestors -> this sample -> operations and tests by date ->
// descendants. The page lays the list out as a horizontal strip (or a vertical list when narrow).
//
// Everything in the response was already filtered through the caller's permissions by the endpoint:
// what they may not read is only counted (`hidden`), and shows as a "N not visible to you" marker.

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
	hidden: { stock_origins: number; ancestors: number; events: number; descendants: number };
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
	/** Reached only through a sample the user cannot see. */
	throughHidden: boolean;
}

export function hiddenText(n: number): string {
	return `${n} not visible to you`;
}

function relation(n: TraceRelative): string {
	const parts: string[] = [];
	if (n.relationship_type) parts.push(String(n.relationship_type).replace(/_/g, ' '));
	if (n.fraction !== null && n.fraction !== undefined) parts.push(`fraction ${n.fraction}`);
	return parts.join(', ');
}

const join = (parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join(' · ');

function hiddenMarker(group: string, n: number): LifeItem[] {
	if (!n) return [];
	return [
		{ key: `hidden-${group}`, kind: 'hidden', label: hiddenText(n), sub: '', date: null, to: null, throughHidden: false },
	];
}

export function buildLife(trace: TraceResponse): LifeItem[] {
	const items: LifeItem[] = [];

	for (const s of trace.stock_origins) {
		items.push({
			key: `stock-${s.lot_id}|${s.via_sample_id}`,
			kind: 'stock',
			label: s.lot_code || 'Stock lot',
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
			label: e.label ?? '—',
			sub: isTest ? (e.status ?? '') : e.sequence !== null && e.sequence !== undefined ? `#${e.sequence}` : '',
			date: e.date,
			to: recordRoute(e.collection, e.id),
			throughHidden: false,
		});
	}
	items.push(...hiddenMarker('events', trace.hidden.events));

	for (const d of [...trace.descendants].sort((a, b) => a.depth - b.depth)) {
		items.push({
			key: `descendant-${d.sample_id}`,
			kind: 'descendant',
			label: d.sample_code || 'Sample',
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
