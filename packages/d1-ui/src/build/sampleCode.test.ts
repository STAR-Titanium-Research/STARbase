import { describe, expect, it } from 'vitest';
import { sampleCodeTemplate } from './sampleCode';

describe('sampleCodeTemplate', () => {
	it('composes {seq}-alloy-method-Y-M-D without zero padding', () => {
		expect(sampleCodeTemplate({ alloyCode: 'Ti64', methodCode: 'MF', date: new Date(2026, 9, 4, 12) })).toBe('{seq}-Ti64-MF-2026-10-4');
	});

	it('reads an ISO timestamp the way register-sample always has (local calendar day)', () => {
		expect(sampleCodeTemplate({ alloyCode: 'A', methodCode: 'B', date: '2026-03-09T12:00:00' })).toBe('{seq}-A-B-2026-3-9');
	});

	it('is empty until the alloy and the method are known', () => {
		expect(sampleCodeTemplate({ alloyCode: null, methodCode: 'MF', date: new Date() })).toBe('');
		expect(sampleCodeTemplate({ alloyCode: 'Ti64', methodCode: undefined, date: new Date() })).toBe('');
		expect(sampleCodeTemplate({ alloyCode: '', methodCode: 'MF' })).toBe('');
	});

	it('uses today when there is no date', () => {
		const d = new Date();
		expect(sampleCodeTemplate({ alloyCode: 'A', methodCode: 'B' })).toBe(`{seq}-A-B-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
	});

	it('can show a number or a question mark in place of {seq}', () => {
		expect(sampleCodeTemplate({ alloyCode: 'A', methodCode: 'B', date: new Date(2026, 0, 2, 12) }, '17')).toBe('17-A-B-2026-1-2');
		expect(sampleCodeTemplate({ alloyCode: 'A', methodCode: 'B', date: new Date(2026, 0, 2, 12) }, '?')).toBe('?-A-B-2026-1-2');
	});
});
