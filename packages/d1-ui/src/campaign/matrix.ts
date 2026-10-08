// The campaign's sample x step matrix (pure logic, no Vue, no network).
//
// Rows are the campaign's samples: the `campaign_samples` junction, plus any sample that only
// appears through an operation or test of the campaign (flagged `notInCampaign`, as in the roll-up).
// Columns are the campaign's operations, then its test types:
//   - an operation with an `operation_sequence` shares a column with the operations of the same
//     sequence and process category on the other samples (the sequence is per sample, so "step 3
//     of machining" lines up across the rows);
//   - an operation without a sequence gets a column of its own, labelled with its pass_code;
//   - tests share a column per test_type.
// A sample with nothing in a column has no cell (the matrix is sparse on purpose).
//
// An operation cell is the worst across the force files (machining_force_analysis rows) of the
// operations in it, error > processing > pending > done > skipped, 'none' when there are no files,
// with the Diagnostics build (`diag_status`) as a second marker. A test cell is the least advanced
// session status of the tests in it (failed first, processed / analysed last).

import { TEST_RANK } from '../status';
import { analysisState, diagState, hiddenSampleCount, relCode, relId } from './rollup';

export type CellKind = 'operation' | 'test';

export interface MatrixColumn {
	key: string;
	kind: CellKind;
	/** Short heading: "#3", the pass_code, or the test type. */
	label: string;
	/** Second line: the process category (operations) or nothing. */
	sub: string;
	/** operation_sequence, for operation columns that have one. */
	sequence: number | null;
}

export interface MatrixCell {
	kind: CellKind;
	/** Operations: force-analysis state (`none` when no force file). Tests: the session status. */
	status: string;
	/** Operations only: roll-up of `diag_status` over the files that can be built, else 'none'. */
	diag: string;
	/** The first force-analysis error message, if the state is `error`. */
	error: string | null;
	/** The first diagnostics error message, if the diagnostics state is `error`. */
	diagError: string | null;
	/** How many operations or tests are in this cell (more than one is rare but possible). */
	count: number;
	/** The record a click opens: the worst operation or test in the cell. */
	collection: 'manufacturing_operations' | 'test_sessions';
	id: string;
	/** Name of that record (pass_code or test type), for the tooltip. */
	name: string;
}

export interface MatrixRow {
	sample_id: string;
	sample_code: string | null;
	/** Has an operation or test in this campaign but is not in `campaign_samples`. */
	notInCampaign: boolean;
	cells: Record<string, MatrixCell>;
}

export interface Matrix {
	columns: MatrixColumn[];
	rows: MatrixRow[];
	/**
	 * What has no row because its sample is not visible to the reader: operations and tests with no
	 * readable sample, and sample-list entries (`campaign_samples`) whose sample is hidden.
	 */
	unplaced: { operations: number; tests: number; samples: number };
}

export interface MatrixInput {
	samples?: any[];
	operations?: any[];
	tests?: any[];
	analyses?: any[];
}

// Least advanced first (TEST_RANK, from the lifecycle in status.ts). An unknown status (added by a
// later migration) sorts with 'registered'.
const testRank = (s: string | null | undefined) => TEST_RANK[s ?? ''] ?? TEST_RANK.registered;

// Severity of a force-analysis state, for choosing which operation of a cell a click opens.
const FORCE_RANK: Record<string, number> = { error: 0, processing: 1, pending: 2, done: 3, skipped: 4, none: 5 };

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

interface OpRef {
	operation: any;
	rows: any[];
	state: string;
}

export function buildMatrix({ samples = [], operations = [], tests = [], analyses = [] }: MatrixInput): Matrix {
	const filesByOp = new Map<string, any[]>();
	for (const a of analyses) {
		const k = relId(a?.operation_id, 'operation_id');
		if (!k) continue;
		let list = filesByOp.get(k);
		if (!list) filesByOp.set(k, (list = []));
		list.push(a);
	}

	// ---- rows ----
	const sampleRows = new Map<string, MatrixRow>();
	const touch = (id: string | null, code: string | null, member: boolean): MatrixRow | null => {
		if (!id) return null;
		let row = sampleRows.get(id);
		if (!row) {
			row = { sample_id: id, sample_code: code, notInCampaign: true, cells: {} };
			sampleRows.set(id, row);
		}
		if (code && !row.sample_code) row.sample_code = code;
		if (member) row.notInCampaign = false;
		return row;
	};
	for (const j of samples) touch(relId(j?.sample_id, 'sample_id'), relCode(j?.sample_id), true);

	const unplaced = { operations: 0, tests: 0, samples: hiddenSampleCount(samples) };

	// ---- operation columns and cells ----
	const columns = new Map<string, MatrixColumn>();
	const cellOps = new Map<string, Map<string, OpRef[]>>(); // sample -> column -> operations
	for (const o of operations) {
		const row = touch(relId(o?.sample_id, 'sample_id'), relCode(o?.sample_id), false);
		if (!row) {
			unplaced.operations++;
			continue;
		}
		const seq = typeof o.operation_sequence === 'number' ? o.operation_sequence : null;
		const category = o.process_category ?? '';
		const key = seq !== null ? `op:${seq}:${category}` : `op:code:${o.pass_code ?? o.operation_id}`;
		if (!columns.has(key)) {
			columns.set(key, {
				key,
				kind: 'operation',
				label: seq !== null ? `#${seq}` : (o.pass_code ?? 'Operation'),
				sub: String(category).replace(/_/g, ' '),
				sequence: seq,
			});
		}
		const rows = filesByOp.get(o.operation_id) ?? [];
		let bySample = cellOps.get(row.sample_id);
		if (!bySample) cellOps.set(row.sample_id, (bySample = new Map()));
		let list = bySample.get(key);
		if (!list) bySample.set(key, (list = []));
		list.push({ operation: o, rows, state: analysisState(rows) });
	}

	for (const [sampleId, byColumn] of cellOps) {
		const row = sampleRows.get(sampleId)!;
		for (const [key, refs] of byColumn) {
			const files = refs.flatMap((r) => r.rows);
			const status = analysisState(files);
			const lead = [...refs].sort((a, b) => FORCE_RANK[a.state] - FORCE_RANK[b.state])[0];
			row.cells[key] = {
				kind: 'operation',
				status,
				diag: diagState(files),
				error: files.find((f) => f?.status === 'error' && f.error_message)?.error_message ?? null,
				diagError: files.find((f) => f?.diag_status === 'error' && f.diag_error)?.diag_error ?? null,
				count: refs.length,
				collection: 'manufacturing_operations',
				id: lead.operation.operation_id,
				name: lead.operation.pass_code ?? 'Operation',
			};
		}
	}

	// ---- test columns and cells ----
	const cellTests = new Map<string, Map<string, any[]>>();
	for (const t of tests) {
		const row = touch(relId(t?.sample_id, 'sample_id'), relCode(t?.sample_id), false);
		if (!row) {
			unplaced.tests++;
			continue;
		}
		const type = t.test_type ?? 'Test';
		const key = `test:${type}`;
		if (!columns.has(key)) columns.set(key, { key, kind: 'test', label: type, sub: 'test', sequence: null });
		let bySample = cellTests.get(row.sample_id);
		if (!bySample) cellTests.set(row.sample_id, (bySample = new Map()));
		let list = bySample.get(key);
		if (!list) bySample.set(key, (list = []));
		list.push(t);
	}
	for (const [sampleId, byColumn] of cellTests) {
		const row = sampleRows.get(sampleId)!;
		for (const [key, list] of byColumn) {
			const sorted = [...list].sort((a, b) => testRank(a.status) - testRank(b.status));
			const lead = sorted[0];
			row.cells[key] = {
				kind: 'test',
				status: lead.status ?? 'registered',
				diag: 'none',
				error: null,
				diagError: null,
				count: list.length,
				collection: 'test_sessions',
				id: lead.session_id,
				name: lead.test_type ?? 'Test',
			};
		}
	}

	// ---- order ----
	const opColumns = [...columns.values()]
		.filter((c) => c.kind === 'operation')
		.sort((a, b) => {
			if (a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) return a.sequence - b.sequence;
			if ((a.sequence === null) !== (b.sequence === null)) return a.sequence === null ? 1 : -1;
			return natural(a.sub, b.sub) || natural(a.label, b.label);
		});
	const testColumns = [...columns.values()].filter((c) => c.kind === 'test').sort((a, b) => natural(a.label, b.label));
	const rows = [...sampleRows.values()].sort((a, b) => natural(a.sample_code ?? '', b.sample_code ?? ''));

	return { columns: [...opColumns, ...testColumns], rows, unplaced };
}
