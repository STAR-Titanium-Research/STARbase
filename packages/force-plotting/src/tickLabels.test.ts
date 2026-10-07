import { describe, expect, it } from 'vitest';
import { fmt, niceTicks } from './frmExport';
import { fmtTick, logTickLabels, tickDecimals, tickLabels, tickStep } from './tickLabels';

const labelsFor = (lo: number, hi: number, target = 5) => tickLabels(niceTicks(lo, hi, target));
const distinct = (a: string[]) => new Set(a).size === a.length;

describe('tickDecimals', () => {
	it('is max(0, -floor(log10(step)))', () => {
		expect(tickDecimals(5)).toBe(0);
		expect(tickDecimals(1)).toBe(0);
		expect(tickDecimals(0.5)).toBe(1);
		expect(tickDecimals(0.05)).toBe(2);
		expect(tickDecimals(0.02)).toBe(2);
		expect(tickDecimals(0.001)).toBe(3);
		expect(tickDecimals(0)).toBe(0);
	});
	it('does not cost a digit for a step that arrives as 0.0999999999', () => {
		expect(tickDecimals(0.09999999999999964)).toBe(1);
	});
});

describe('tick labels follow the step', () => {
	it('12.30-12.45 s gives distinct labels (the old fmt gave "12" for all)', () => {
		const ticks = niceTicks(12.3, 12.45, 5);
		expect(new Set(ticks.map(fmt)).size).toBeLessThan(ticks.length); // the bug
		const l = tickLabels(ticks);
		expect(distinct(l)).toBe(true);
		expect(l[0]).toBe('12.30');
		expect(l.every((s) => /^12\.\d\d$/.test(s))).toBe(true);
	});
	it('1195-1205 rpm gives distinct labels (the old fmt gave "1.2k" for all)', () => {
		const ticks = niceTicks(1195, 1205, 5);
		expect(new Set(ticks.map(fmt)).size).toBe(1);
		const l = tickLabels(ticks);
		expect(distinct(l)).toBe(true);
		expect(l).toContain('1200');
	});
	it('stays distinct across magnitudes and offsets', () => {
		for (const [lo, hi] of [[0, 0.004], [0.0123, 0.0149], [-0.3, 0.3], [99.5, 100.5], [4.95, 5.05], [-1203.4, -1201.2], [0, 7], [0, 60], [1e-4, 9e-4]]) {
			expect(distinct(labelsFor(lo, hi)), `${lo}..${hi}: ${labelsFor(lo, hi)}`).toBe(true);
		}
	});
	it('large ranges read as before', () => {
		for (const [lo, hi] of [[0, 5000], [0, 400], [0, 20000], [-500, 500], [0, 60], [0, 1500]]) {
			const ticks = niceTicks(lo, hi, 5);
			const step = tickStep(ticks);
			if (step < 1) continue;
			const old = ticks.map(fmt);
			// integers: the only change allowed is "5.0" -> "5" style trailing zero for steps below 10
			expect(tickLabels(ticks).map((s) => s.replace(/\.0$/, ''))).toEqual(old.map((s) => s.replace(/\.0$/, '')));
		}
		expect(labelsFor(0, 5000)).toEqual(['0', '1.0k', '2.0k', '3.0k', '4.0k', '5.0k']);
		expect(labelsFor(0, 400)).toEqual(['0', '100', '200', '300', '400']);
	});
	it('uses M only once the step allows it', () => {
		expect(fmtTick(2e6, 5e5)).toBe('2.0M');
		expect(fmtTick(2e6, 10)).toBe('2000000');
	});
	it('never prints a negative zero', () => {
		expect(tickLabels([-0.0000001, 0.05, 0.1])[0]).toBe('0.00');
	});
	it('falls back to fmt without a step', () => {
		expect(tickLabels([3])).toEqual([fmt(3)]);
	});
});

describe('logTickLabels', () => {
	it('does not round small decades to 0.000', () => {
		expect(logTickLabels([1e-5, 1e-4, 1e-3, 0.01, 0.1, 1, 10, 100, 1000])).toEqual(['1e-5', '1e-4', '0.001', '0.01', '0.1', '1', '10', '100', '1.0k']);
	});
});
