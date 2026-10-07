import { describe, expect, it } from 'vitest';
import { markInView, markTagText } from './chartMark';

describe('markInView', () => {
	it('accepts values inside the window, edges included', () => {
		expect(markInView(5, 0, 10)).toBe(true);
		expect(markInView(0, 0, 10)).toBe(true);
		expect(markInView(10, 0, 10)).toBe(true);
	});
	it('rejects outside, null, undefined and non-finite', () => {
		expect(markInView(-0.1, 0, 10)).toBe(false);
		expect(markInView(10.1, 0, 10)).toBe(false);
		expect(markInView(null, 0, 10)).toBe(false);
		expect(markInView(undefined, 0, 10)).toBe(false);
		expect(markInView(NaN, 0, 10)).toBe(false);
	});
});

describe('markTagText', () => {
	const fmt = (v: number) => v.toFixed(2);
	it('defaults to t = value unit', () => {
		expect(markTagText(12.345, undefined, 's', fmt)).toBe('t = 12.35 s');
	});
	it('trims when there is no unit', () => {
		expect(markTagText(1, undefined, undefined, fmt)).toBe('t = 1.00');
	});
	it('prefers an explicit label', () => {
		expect(markTagText(1, 'pinned', 's', fmt)).toBe('pinned');
	});
});
