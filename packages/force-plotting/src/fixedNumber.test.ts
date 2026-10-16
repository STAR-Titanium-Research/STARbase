import { describe, expect, it } from 'vitest';
import { fmtFixed } from './fixedNumber';

describe('fmtFixed', () => {
	it('pads and rounds to two decimals by default', () => {
		expect(fmtFixed(60)).toBe('60.00');
		expect(fmtFixed(0.05)).toBe('0.05');
		expect(fmtFixed(0.1)).toBe('0.10');
		expect(fmtFixed(25.6)).toBe('25.60');
	});
	it('is blank for unset or non-numeric values', () => {
		expect(fmtFixed(null)).toBe('');
		expect(fmtFixed(undefined)).toBe('');
		expect(fmtFixed('')).toBe('');
		expect(fmtFixed('abc')).toBe('');
	});
});
