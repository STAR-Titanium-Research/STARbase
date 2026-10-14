import { describe, expect, it } from 'vitest';
import { buildLife, groupLife, type TraceResponse } from './life';
import { fitSplit, splitSummary } from './lifeSplit';

describe('fitSplit', () => {
	it('is null when every step fits, or when there are too few to split', () => {
		expect(fitSplit([100, 100, 100], 300, 50)).toBeNull();
		expect(fitSplit([400, 400], 300, 50)).toBeNull();
	});

	it('keeps the start and the latest steps, the end first, and hides the middle', () => {
		// 10 steps of 100px in 600px with a 100px split: 5 steps show.
		expect(fitSplit(Array(10).fill(100), 600, 100)).toEqual({ head: 2, tail: 3 });
	});

	it('grows the start to reach this sample before sharing the room', () => {
		expect(fitSplit(Array(10).fill(100), 600, 100, 3)).toEqual({ head: 4, tail: 1 });
		expect(fitSplit(Array(10).fill(100), 800, 100, 3)).toEqual({ head: 5, tail: 2 });
	});

	it('keeps filling the other side when one side has a wide step next', () => {
		// The step before the end is 400px: it cannot join, but the start still grows.
		expect(fitSplit([100, 100, 100, 100, 100, 400, 100], 500, 100)).toEqual({ head: 3, tail: 1 });
	});

	it('always hides at least one step and shows the first and last, even when they alone overflow', () => {
		const s = fitSplit([500, 100, 100, 500], 600, 100)!;
		expect(s).toEqual({ head: 1, tail: 1 });
		const all = fitSplit(Array(4).fill(100), 399, 10)!;
		expect(all.head + all.tail).toBe(3);
	});
});

describe('splitSummary', () => {
	const base = (): TraceResponse => ({
		sample: { sample_id: 's0', sample_code: 'S', form: null },
		stock_origins: [],
		ancestors: [{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: null, relationship_type: null, fraction: null, through_hidden: false }],
		descendants: [],
		events: [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: '2023-03-31', label: null, sequence: 1, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o2', date: '2023-03-31', label: null, sequence: 2, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: '2023-04-20', label: 'tensile', sequence: null, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o3', date: null, label: null, sequence: 3, status: null },
		],
		hidden: { stock_origins: false, ancestors: false, events: false, descendants: false },
		truncated: {},
	});

	it('counts what the hidden steps hold and gives their dates', () => {
		const steps = groupLife(buildLife(base()));
		expect(splitSummary(steps)).toEqual({
			label: '5 more steps',
			lines: ['3 operations · 1 test', '1 sample', '31 Mar 2023 – 20 Apr 2023'],
		});
		expect(splitSummary(steps.slice(2, 3))).toEqual({ label: '1 more step', lines: ['2 operations', '31 Mar 2023'] });
	});
});
