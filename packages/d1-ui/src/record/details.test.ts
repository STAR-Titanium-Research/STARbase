import { describe, expect, it } from 'vitest';
import { detailFacts, detailsCount, paramFact } from './details';
import type { ParamRow } from '../params';

const p = (label: string, value: string, unit = ''): ParamRow => ({ field: label, label, value, unit });

describe('paramFact', () => {
	it('carries the unit, and none when the parameter has no unit', () => {
		expect(paramFact(p('Feed', '0.2', 'mm/rev'))).toEqual({ label: 'Feed', value: '0.2', unit: 'mm/rev' });
		expect(paramFact(p('Coolant', 'Yes')).unit).toBeUndefined();
	});
});

describe('detailFacts', () => {
	it('lists the record facts first and the parameters after them, without empty ones', () => {
		const out = detailFacts([{ label: 'Step', value: 2 }, { label: 'Software', value: '' }], [p('Feed', '0.2', 'mm/rev')], []);
		expect(out.map((f) => f.label)).toEqual(['Step', 'Feed']);
		expect(out[1]).toMatchObject({ value: '0.2', unit: 'mm/rev' });
	});

	it('keeps a zero', () => {
		expect(detailFacts([{ label: 'Step', value: 0 }], [], []).map((f) => f.label)).toEqual(['Step']);
	});

	it('drops a fact the rail already shows (same label, same value)', () => {
		const out = detailFacts([{ label: 'Method', value: 'Turning' }], [p('machine', 'NLX 2500')], [
			{ label: 'Method', value: 'Turning' },
			{ label: 'Machine', value: 'NLX 2500' },
		]);
		expect(out).toEqual([]);
	});

	it('keeps a fact whose label is in the rail but whose value differs', () => {
		const out = detailFacts([], [p('Date', '2 May 2024')], [{ label: 'Date', value: '1 May 2024' }]);
		expect(out.map((f) => f.value)).toEqual(['2 May 2024']);
	});

	it('shows the same label with the same value once', () => {
		expect(detailFacts([{ label: 'Feed', value: '0.2' }], [p('Feed', '0.2')], [])).toHaveLength(1);
	});

	it('keeps the same label with a different value, renamed so the list keys stay unique', () => {
		const out = detailFacts([{ label: 'Feed', value: '0.2' }], [p('Feed', '0.3'), p('Feed', '0.4')], []);
		expect(out.map((f) => [f.label, f.value])).toEqual([['Feed', '0.2'], ['Feed (2)', '0.3'], ['Feed (3)', '0.4']]);
	});
});

describe('detailsCount', () => {
	it('is the number of facts once the parameters have loaded', () => {
		expect(detailsCount(5, false, false, '')).toBe(5);
		expect(detailsCount(5, true, false, undefined)).toBe(5);
	});

	it('is unknown (null) while the parameters load or when their read failed', () => {
		expect(detailsCount(0, false, true, '')).toBeNull();
		expect(detailsCount(3, false, true, '')).toBeNull();
		expect(detailsCount(0, false, false, 'Could not load parameters')).toBeNull();
	});

	it('is 0 (listed dimmed) with no facts and no notes, and no count with notes only', () => {
		expect(detailsCount(0, false, false, '')).toBe(0);
		expect(detailsCount(0, true, false, '')).toBeNull();
	});
});
