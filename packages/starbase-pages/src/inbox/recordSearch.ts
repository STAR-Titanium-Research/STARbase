// The record picker of the Link dialog: which records a search offers for a link target (sample, operation, test), and how a row reads.
// Reads go through /items as the signed-in user, so a person is offered only records Directus lets them read; whether they may EDIT one
// is decided by the endpoint when they link (a view-only record is refused with its own message).
import { operationLabel } from '@d1/ui';
import type { LinkTarget } from './inboxModel';

export const MIN_QUERY = 2;
export const RESULT_LIMIT = 8;
export const SEARCH_DEBOUNCE_MS = 250;

const SHORT_ID = /^[0-9a-f]{8,32}$/i;

export interface RecordOption {
	collection: string;
	id: string;
	/** "S-0042" */
	label: string;
	/** A second line: the nickname, the test type. */
	detail: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

interface SearchDef {
	fields: string[];
	match: string[];
	label(row: any): string;
	detail(row: any): string;
}

// The fields and matches are the finder's (packages/d1-ui finder.ts FINDER_SOURCES), so a record is found here by what finds it there.
const DEFS: Record<string, SearchDef> = {
	physical_samples: {
		fields: ['sample_id', 'sample_code', 'nickname', 'short_id'],
		match: ['sample_code', 'nickname'],
		label: (r) => str(r.sample_code) || 'Sample',
		detail: (r) => str(r.nickname),
	},
	manufacturing_operations: {
		fields: ['operation_id', 'pass_code', 'operation_sequence', 'sample_id.sample_code', 'short_id'],
		match: ['pass_code'],
		label: (r) => operationLabel(r),
		detail: () => '',
	},
	test_sessions: {
		fields: ['session_id', 'test_code', 'test_type', 'short_id'],
		match: ['test_code'],
		label: (r) => str(r.test_code) || 'Test',
		detail: (r) => str(r.test_type),
	},
};

export const isSearchable = (q: string): boolean => q.trim().length >= MIN_QUERY;

/** Params for GET /items/<collection>: fields as an array, the filter as a JSON string (as the kit's other reads send it). */
export function searchParams(target: LinkTarget, q: string): Record<string, unknown> {
	const def = DEFS[target.collection];
	const text = q.trim();
	const or: unknown[] = def.match.map((field) => ({ [field]: { _icontains: text } }));
	if (SHORT_ID.test(text)) or.push({ short_id: { _eq: text.toLowerCase() } });
	return { fields: def.fields, filter: JSON.stringify({ _or: or }), limit: RESULT_LIMIT };
}

export function toOption(target: LinkTarget, row: any): RecordOption | null {
	const id = row?.[target.idField];
	if (typeof id !== 'string' || !id) return null;
	const def = DEFS[target.collection];
	return { collection: target.collection, id, label: def.label(row), detail: def.detail(row) };
}
