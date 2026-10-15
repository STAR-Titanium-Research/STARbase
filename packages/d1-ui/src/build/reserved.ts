// Fields a draft's `values` may not carry, per kind of draft item: the wiring, the work state and the database decide them, and
// `d1-build` refuses a draft that sets one (core/extensions/d1-build/index.js `RESERVED_FIELDS`). The rail's form leaves them out
// so it can never offer a field the server will refuse. A parity test (reserved.test.ts) reads the endpoint's list as text and
// checks it is a subset of this one, so the two cannot drift apart unnoticed. This list may be longer: it also holds fields the
// draft fills in by itself where the server has no rule (the operation sequence, the codes' bookkeeping).

export type DraftKind = 'sample' | 'operation' | 'test';

const COMMON = ['version', 'created_at', 'updated_at', 'short_id', 'code_sort', 'created_by', 'restricted'] as const;

export const RESERVED_FIELDS: Readonly<Record<DraftKind, readonly string[]>> = {
	sample: ['sample_id', 'current_status', ...COMMON],
	operation: ['operation_id', 'sample_id', 'output_sample_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'operation_sequence', ...COMMON],
	test: ['session_id', 'sample_id', 'subject', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'insert_edge_id', ...COMMON],
};

/** Is `field` one the server refuses in a draft item of this kind? */
export const isReserved = (kind: DraftKind, field: string): boolean => RESERVED_FIELDS[kind].includes(field);
