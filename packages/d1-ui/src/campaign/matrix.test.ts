import { describe, expect, it } from 'vitest';
import { buildMatrix } from './matrix';

const S1 = { sample_id: 's1', sample_code: '9-A-1' };
const S2 = { sample_id: 's2', sample_code: '9-A-2' };
const S10 = { sample_id: 's10', sample_code: '9-A-10' };

const op = (operation_id: string, sample: any, extra: Record<string, unknown> = {}) => ({
	operation_id,
	pass_code: `${sample?.sample_code ?? 'x'}-${operation_id}`,
	process_category: 'machining',
	sample_id: sample,
	...extra,
});

describe('buildMatrix rows', () => {
	it('lists junction samples plus samples seen only through operations or tests, flagged', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S10 }, { sample_id: S1 }],
			operations: [op('o1', S2, { operation_sequence: 1 })],
			tests: [{ session_id: 't1', test_type: 'tensile', status: 'registered', sample_id: S1 }],
		});
		expect(m.rows.map((r) => [r.sample_code, r.notInCampaign])).toEqual([
			['9-A-1', false],
			['9-A-2', true],
			['9-A-10', false],
		]);
	});

	it('keeps a sample with no operations or tests as an empty row', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			operations: [op('o1', S1, { operation_sequence: 1 })],
		});
		expect(m.rows).toHaveLength(2);
		expect(m.rows[1].sample_code).toBe('9-A-2');
		expect(m.rows[1].cells).toEqual({});
	});

	it('an empty campaign gives an empty matrix', () => {
		expect(buildMatrix({})).toEqual({ columns: [], rows: [], unplaced: { operations: 0, tests: 0, samples: 0 } });
	});

	it('counts operations and tests whose sample cannot be read instead of dropping them silently', () => {
		const m = buildMatrix({
			samples: [{ sample_id: null }],
			operations: [op('o1', null)],
			tests: [{ session_id: 't1', test_type: 'tensile', status: 'processed', sample_id: null }],
		});
		expect(m.rows).toEqual([]);
		expect(m.unplaced).toEqual({ operations: 1, tests: 1, samples: 1 });
	});
});

describe('buildMatrix columns', () => {
	it('lines operations up by sequence across samples, then test types', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			operations: [
				op('o1', S1, { operation_sequence: 2 }),
				op('o2', S1, { operation_sequence: 1 }),
				op('o3', S2, { operation_sequence: 2 }),
			],
			tests: [
				{ session_id: 't1', test_type: 'tensile', status: 'registered', sample_id: S1 },
				{ session_id: 't2', test_type: 'hardness', status: 'registered', sample_id: S2 },
			],
		});
		expect(m.columns.map((c) => [c.kind, c.label])).toEqual([
			['operation', '#1'],
			['operation', '#2'],
			['test', 'hardness'],
			['test', 'tensile'],
		]);
		const col2 = m.columns[1].key;
		expect(m.rows[0].cells[col2].id).toBe('o1');
		expect(m.rows[1].cells[col2].id).toBe('o3');
	});

	it('gives an operation without a sequence its own column, labelled by pass_code, after numbered ones', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			operations: [
				op('o1', S1, { pass_code: 'B-pass' }),
				op('o2', S2, { pass_code: 'A-pass' }),
				op('o3', S1, { operation_sequence: 5 }),
			],
		});
		expect(m.columns.map((c) => c.label)).toEqual(['#5', 'A-pass', 'B-pass']);
	});

	it('does not merge the same sequence of different process categories', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			operations: [
				op('o1', S1, { operation_sequence: 1, process_category: 'machining' }),
				op('o2', S2, { operation_sequence: 1, process_category: 'heat_treatment' }),
			],
		});
		expect(m.columns).toHaveLength(2);
		expect(m.columns.map((c) => c.sub).sort()).toEqual(['heat treatment', 'machining']);
		// each sample has a cell in one column only (sparse)
		expect(Object.keys(m.rows[0].cells)).toHaveLength(1);
		expect(Object.keys(m.rows[1].cells)).toHaveLength(1);
	});
});

describe('buildMatrix operation cells', () => {
	const cell = (m: ReturnType<typeof buildMatrix>, row = 0, col = 0) => m.rows[row].cells[m.columns[col].key];

	it('has status none (not a missing cell) for an operation with no force file', () => {
		const m = buildMatrix({ samples: [{ sample_id: S1 }], operations: [op('o1', S1, { operation_sequence: 1 })] });
		expect(cell(m).status).toBe('none');
		expect(cell(m).diag).toBe('none');
	});

	it('rolls several files of one operation up, worst first', () => {
		const run = (statuses: string[]) =>
			cell(
				buildMatrix({
					samples: [{ sample_id: S1 }],
					operations: [op('o1', S1, { operation_sequence: 1 })],
					analyses: statuses.map((status) => ({ operation_id: 'o1', status })),
				}),
			).status;
		expect(run(['done', 'done'])).toBe('done');
		expect(run(['done', 'skipped'])).toBe('done');
		expect(run(['skipped', 'skipped'])).toBe('skipped');
		expect(run(['done', 'pending'])).toBe('pending');
		expect(run(['pending', 'processing', 'done'])).toBe('processing');
		expect(run(['done', 'pending', 'processing', 'error', 'skipped'])).toBe('error');
	});

	it('error wins over every other state and carries its message, with diagnostics as a second marker', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }],
			operations: [op('o1', S1, { operation_sequence: 1 })],
			analyses: [
				{ operation_id: 'o1', status: 'done', diag_status: 'done' },
				{ operation_id: 'o1', status: 'error', error_message: 'bad file', diag_status: null },
				{ operation_id: 'o1', status: 'processing', diag_status: 'error', diag_error: 'build failed' },
			],
		});
		const c = cell(m);
		expect(c.status).toBe('error');
		expect(c.error).toBe('bad file');
		expect(c.diag).toBe('error');
		expect(c.diagError).toBe('build failed');
	});

	it('marks diagnostics built only when every buildable file is, ignoring skipped files', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			operations: [op('o1', S1, { operation_sequence: 1 }), op('o2', S2, { operation_sequence: 1 })],
			analyses: [
				{ operation_id: 'o1', status: 'done', diag_status: 'done' },
				{ operation_id: 'o1', status: 'skipped', diag_status: null },
				{ operation_id: 'o2', status: 'done', diag_status: 'done' },
				{ operation_id: 'o2', status: 'done', diag_status: null },
			],
		});
		expect(cell(m, 0).diag).toBe('done');
		expect(cell(m, 1).diag).toBe('none');
	});

	it('an operation whose files were all skipped reads skipped', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }],
			operations: [op('o1', S1, { operation_sequence: 1 })],
			analyses: [
				{ operation_id: 'o1', status: 'skipped' },
				{ operation_id: 'o1', status: 'skipped' },
			],
		});
		expect(cell(m).status).toBe('skipped');
		expect(cell(m).error).toBeNull();
	});

	it('reads the operation id from an expanded relation too', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }],
			operations: [op('o1', S1, { operation_sequence: 1 })],
			analyses: [{ operation_id: { operation_id: 'o1' }, status: 'error', error_message: 'x' }],
		});
		expect(cell(m).status).toBe('error');
	});

	it('merges two operations of one sample in one column and opens the worst one', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }],
			operations: [op('o1', S1, { operation_sequence: 1 }), op('o2', S1, { operation_sequence: 1 })],
			analyses: [
				{ operation_id: 'o1', status: 'done' },
				{ operation_id: 'o2', status: 'error', error_message: 'oops' },
			],
		});
		expect(m.columns).toHaveLength(1);
		expect(cell(m)).toMatchObject({ status: 'error', count: 2, id: 'o2', collection: 'manufacturing_operations' });
	});
});

describe('buildMatrix test cells', () => {
	it('takes the least advanced status of several sessions of one type, failed first', () => {
		const run = (statuses: string[]) => {
			const m = buildMatrix({
				samples: [{ sample_id: S1 }],
				tests: statuses.map((status, i) => ({ session_id: `t${i}`, test_type: 'tensile', status, sample_id: S1 })),
			});
			return m.rows[0].cells[m.columns[0].key];
		};
		expect(run(['analysed', 'processed']).status).toBe('processed');
		expect(run(['processed', 'registered']).status).toBe('registered');
		expect(run(['processed', 'processing', 'registered']).status).toBe('processing');
		expect(run(['analysed', 'failed', 'processing']).status).toBe('failed');
		const c = run(['analysed', 'failed']);
		expect(c).toMatchObject({ kind: 'test', count: 2, id: 't1', collection: 'test_sessions', name: 'tensile' });
	});

	it('shares a column per test type and leaves other samples blank', () => {
		const m = buildMatrix({
			samples: [{ sample_id: S1 }, { sample_id: S2 }],
			tests: [{ session_id: 't1', test_type: 'tensile', status: 'processed', sample_id: S1 }],
		});
		expect(m.columns).toHaveLength(1);
		expect(m.rows[0].cells['test:tensile'].status).toBe('processed');
		expect(m.rows[1].cells['test:tensile']).toBeUndefined();
	});
});
