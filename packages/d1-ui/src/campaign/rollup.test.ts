import { describe, expect, it } from 'vitest';
import { TEST_STATUS_ORDER } from '../status';
import { analysisState, buildOverview, countsTowardForceProgress, diagState, hiddenSampleCount } from './rollup';

// Ported from core/extensions/d1-campaign-ops/index.test.mjs (node:test); the cases are unchanged.
describe('campaign roll-up', () => {
	it('analysisState rolls several files up, worst first', () => {
		expect(analysisState([])).toBe('none');
		expect(analysisState(undefined)).toBe('none');
		expect(analysisState([{ status: 'done' }, { status: 'error' }])).toBe('error');
		expect(analysisState([{ status: 'done' }, { status: 'processing' }, { status: 'pending' }])).toBe('processing');
		expect(analysisState([{ status: 'done' }, { status: 'pending' }])).toBe('pending');
		expect(analysisState([{ status: 'done' }, { status: 'skipped' }])).toBe('done');
		expect(analysisState([{ status: 'skipped' }])).toBe('skipped');
	});

	it('diagState treats a missing diag_status as not built', () => {
		expect(diagState([])).toBe('none');
		expect(diagState([{ diag_status: null }, {}])).toBe('none');
		expect(diagState([{ diag_status: 'done' }, { diag_status: 'done' }])).toBe('done');
		// one built file and one never requested: the operation is not built
		expect(diagState([{ diag_status: 'done' }, { diag_status: null }])).toBe('none');
		expect(diagState([{ diag_status: 'done' }, { diag_status: 'error' }])).toBe('error');
		expect(diagState([{ diag_status: 'pending' }, { diag_status: 'done' }])).toBe('pending');
		expect(diagState([{ diag_status: null }, { diag_status: 'processing' }])).toBe('processing');
	});

	it('diagState ignores skipped files and errored analyses that never got a diag_status', () => {
		expect(diagState([{ status: 'done', diag_status: 'done' }, { status: 'skipped', diag_status: null }])).toBe('done');
		expect(diagState([{ status: 'done', diag_status: 'done' }, { status: 'error', diag_status: null }])).toBe('done');
		// an analysis that errored but whose diagnostics did get a status still counts
		expect(diagState([{ status: 'done', diag_status: 'done' }, { status: 'error', diag_status: 'error' }])).toBe('error');
		// a done file that is not built yet still reads 'none'
		expect(diagState([{ status: 'done', diag_status: null }, { status: 'skipped', diag_status: null }])).toBe('none');
		// nothing buildable at all: nothing to build
		expect(diagState([{ status: 'skipped', diag_status: null }])).toBe('none');
	});

	it('diagnostics progress does not count an operation with an unbuilt file', () => {
		const o = buildOverview({
			operations: [
				{ operation_id: 'o1', process_category: 'machining' },
				{ operation_id: 'o2', process_category: 'machining' },
			],
			analyses: [
				{ operation_id: 'o1', status: 'done', diag_status: 'done' },
				{ operation_id: 'o1', status: 'done', diag_status: null },
				{ operation_id: 'o2', status: 'done', diag_status: 'done' },
			],
		});
		expect(o.progress.analysed).toBe(2);
		expect(o.progress.diagBuilt).toBe(1);
		expect(o.progress.diagBuiltPct).toBe(50);
	});

	it('operations whose force files were all skipped are not in the force-analysis denominator', () => {
		const o = buildOverview({
			operations: [
				{ operation_id: 'o1', process_category: 'machining' },
				{ operation_id: 'o2', process_category: 'machining' },
				{ operation_id: 'o3', process_category: 'machining' },
			],
			analyses: [
				{ operation_id: 'o1', status: 'done', diag_status: 'done' },
				{ operation_id: 'o2', status: 'skipped' },
				{ operation_id: 'o2', status: 'skipped' },
				// o3 mixes done and skipped: it is analysed, and stays in
				{ operation_id: 'o3', status: 'done' },
				{ operation_id: 'o3', status: 'skipped' },
			],
		});
		expect(o.progress.forceOps).toBe(2);
		expect(o.progress.analysed).toBe(2);
		expect(o.progress.analysedPct).toBe(100);
		expect(o.progress.diagBuilt).toBe(1);
		// the skipped operation is still listed with its state
		expect(o.opRows.find((r) => r.operation_id === 'o2')?.analysis).toBe('skipped');
	});

	const S1 = { sample_id: 's1', sample_code: '9-A-1' };
	const S2 = { sample_id: 's2', sample_code: '9-A-2' };
	const S10 = { sample_id: 's10', sample_code: '9-A-10' };

	it('buildOverview counts, per-sample rows and progress', () => {
		const o = buildOverview({
			samples: [{ sample_id: S10 }, { sample_id: S1 }],
			operations: [
				{ operation_id: 'o1', pass_code: 'P1', process_category: 'machining', sample_id: S1 },
				{ operation_id: 'o2', pass_code: 'P2', process_category: 'machining', sample_id: S1 },
				{ operation_id: 'o3', pass_code: 'P3', process_category: 'machining', sample_id: S2 },
				{ operation_id: 'o4', pass_code: 'F1', process_category: 'fast', sample_id: S2 },
			],
			tests: [
				{ session_id: 't1', test_type: 'tensile', status: 'processed', sample_id: S1 },
				{ session_id: 't2', test_type: 'tensile', status: 'registered', sample_id: S10 },
			],
			analyses: [
				{ operation_id: 'o1', status: 'done', diag_status: 'done' },
				{ operation_id: 'o2', status: 'error', error_message: 'bad file', diag_status: null },
				// o3 has no analysis row yet
			],
		});
		expect(o.counts.samples).toBe(3); // S1, S10 from the junction + S2 via its operations
		expect(o.counts.operations).toBe(4);
		expect(o.counts.tests).toBe(2);
		expect(o.counts.testsByStatus).toEqual({ processed: 1, registered: 1 });
		// natural order, member flag, per-sample counts
		expect(o.sampleRows.map((s) => [s.sample_code, s.member, s.operations, s.tests])).toEqual([
				['9-A-1', true, 2, 1],
				['9-A-2', false, 2, 0],
				['9-A-10', true, 0, 1],
			]);
		// FAST operation without a force row is not part of the force-analysis denominator
		expect(o.progress.forceOps).toBe(3);
		expect(o.progress.analysed).toBe(1);
		expect(o.progress.analysedPct).toBe(33);
		expect(o.progress.diagBuilt).toBe(1);
		expect(o.progress.testsCompletePct).toBe(50);
		expect(o.counts.analysisByState).toEqual({ done: 1, error: 1, none: 1 });
		const o2 = o.opRows.find((r) => r.operation_id === 'o2')!;
		expect(o2.analysis).toBe('error');
		expect(o2.analysis_error).toBe('bad file');
		expect(o2.sample_code).toBe('9-A-1');
	});

	it('an empty campaign gives zeros, not NaN', () => {
		const o = buildOverview({});
		expect(o.counts.samples).toBe(0);
		expect(o.progress.analysedPct).toBe(0);
		expect(o.progress.testsCompletePct).toBe(0);
		expect(o.sampleRows).toEqual([]);
	});

	it('rows whose related sample is unreadable (null) do not crash and add no sample', () => {
		const o = buildOverview({
			samples: [{ sample_id: null }],
			operations: [{ operation_id: 'o1', pass_code: 'P1', process_category: 'machining', sample_id: null }],
			tests: [{ session_id: 't1', status: 'processed', sample_id: null }],
		});
		expect(o.counts.samples).toBe(0);
		expect(o.counts.hiddenSamples).toBe(1); // the junction row counts on the campaign card
		expect(o.counts.operations).toBe(1);
		expect(o.counts.tests).toBe(1);
	});

	it('counts junction rows with a hidden (null) sample, not bare ids or readable samples', () => {
		expect(hiddenSampleCount([{ sample_id: null }, { sample_id: 'bare-id' }, { sample_id: { sample_id: 's1' } }, { sample_id: null }])).toBe(2);
		expect(hiddenSampleCount(undefined)).toBe(0);
	});

	it('tests complete counts processed and analysed (the migration-0013 vocabulary), not the retired complete', () => {
		const statuses = ['registered', 'pending_processing', 'processing', 'processed', 'analysing', 'analysed', 'failed'];
		const o = buildOverview({ tests: statuses.map((status, i) => ({ session_id: `t${i}`, status })) });
		expect(o.progress.testsComplete).toBe(2);
		expect(o.progress.testsCompletePct).toBe(29);
		// the retired pre-0013 value cannot occur any more, so it must not be counted
		expect(buildOverview({ tests: [{ session_id: 'x', status: 'complete' }] }).progress.testsComplete).toBe(0);
		// every status of the lifecycle has a chip position
		expect([...TEST_STATUS_ORDER].sort()).toEqual([...statuses].sort());
	});
});

describe('countsTowardForceProgress', () => {
	it('counts machining operations and any operation that has a force file', () => {
		expect(countsTowardForceProgress({ process_category: 'machining' }, 'none')).toBe(true);
		expect(countsTowardForceProgress({ process_category: 'sintering' }, 'done')).toBe(true);
		expect(countsTowardForceProgress({ process_category: 'imaging' }, 'none')).toBe(false);
	});
	it('leaves out an operation whose files were all skipped', () => {
		expect(countsTowardForceProgress({ process_category: 'machining' }, 'skipped')).toBe(false);
	});
});
