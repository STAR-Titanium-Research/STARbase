import { describe, expect, it } from 'vitest';
import { fitText, MIN_PT, SIZE_PT, textWidthMm } from './fit';

describe('fitText', () => {
	it('keeps the base size when the text fits', () => {
		expect(fitText('S-0123', 50, 'lg', true)).toEqual({ pt: SIZE_PT.lg, clipped: false, text: 'S-0123' });
		expect(fitText('x', 50, 'sm', false).pt).toBe(SIZE_PT.sm);
	});
	it('maps sizes to descending pt bases', () => {
		expect(SIZE_PT.lg).toBeGreaterThan(SIZE_PT.md);
		expect(SIZE_PT.md).toBeGreaterThan(SIZE_PT.sm);
	});
	it('shrinks, without clipping, when a smaller size fits', () => {
		const text = '10-AA-MF-2023-06-03';
		const base = textWidthMm(text, SIZE_PT.lg, true);
		const r = fitText(text, base * 0.8, 'lg', true);
		expect(r.clipped).toBe(false);
		expect(r.text).toBe(text);
		expect(r.pt).toBeLessThan(SIZE_PT.lg);
		expect(r.pt).toBeGreaterThanOrEqual(MIN_PT.lg);
		expect(textWidthMm(text, r.pt, true)).toBeLessThanOrEqual(base * 0.8 + 1e-9);
	});
	it('stops at the minimum and cuts with an ellipsis, flagging it clipped', () => {
		const text = 'A very long nickname that cannot possibly fit on one line';
		const r = fitText(text, 30, 'md', false);
		expect(r.clipped).toBe(true);
		expect(r.pt).toBe(MIN_PT.md);
		expect(r.text.endsWith('…')).toBe(true);
		expect(r.text.length).toBeLessThan(text.length);
		expect(text.startsWith(r.text.slice(0, -1))).toBe(true);
		expect(textWidthMm(r.text, r.pt, false)).toBeLessThanOrEqual(30 + 1e-9);
	});
	it('bold is wider than regular', () => {
		expect(textWidthMm('Sample', 10, true)).toBeGreaterThan(textWidthMm('Sample', 10, false));
	});
	it('handles empty text and a box with no room', () => {
		expect(fitText('', 10, 'md', false)).toEqual({ pt: SIZE_PT.md, clipped: false, text: '' });
		expect(fitText('abc', 0, 'md', false)).toEqual({ pt: MIN_PT.md, clipped: true, text: '' });
	});
	it('does not split a surrogate pair when cutting', () => {
		const r = fitText('😀'.repeat(40), 12, 'sm', false);
		expect(r.clipped).toBe(true);
		expect(r.text).toMatch(/^(?:😀)+…$/u);
	});
});

describe('width estimate by character class', () => {
	const w = (s: string) => textWidthMm(s, 10, false);
	it('orders the classes: wide capitals > capitals > digits > lower case > narrow', () => {
		expect(w('WWWW')).toBeGreaterThan(w('AAAA'));
		expect(w('MMMM')).toBeGreaterThan(w('AAAA'));
		expect(w('AAAA')).toBeGreaterThan(w('0000'));
		expect(w('0000')).toBeGreaterThan(w('aaaa'));
		expect(w('aaaa')).toBeGreaterThan(w('iiii'));
		expect(w('aaaa')).toBeGreaterThan(w('----'));
	});
	it('treats every digit alike (tabular figures), and bold as 8% wider', () => {
		expect(w('1111')).toBe(w('0000'));
		expect(textWidthMm('Abc', 10, true) / w('Abc')).toBeCloseTo(1.08, 5);
	});
	it('reports a 36-character run of wide capitals as clipped on an A4 4x5 label', () => {
		const r = fitText('W'.repeat(36), 48.5, 'lg', true);
		expect(r.clipped).toBe(true);
		expect(r.pt).toBe(MIN_PT.lg);
		expect(r.text.endsWith('…')).toBe(true);
	});
});

describe('fitText with a custom measure', () => {
	// 1 mm per character per 10 pt
	const measure = (text: string, pt: number) => Array.from(text).length * (pt / 10);
	it('uses it for shrinking', () => {
		const r = fitText('x'.repeat(20), 15, 'md', false, measure);
		expect(r).toEqual({ pt: 7.5, clipped: false, text: 'x'.repeat(20) });
	});
	it('uses it for cutting, ellipsis included', () => {
		const r = fitText('x'.repeat(40), 20, 'md', false, measure);
		expect(r.clipped).toBe(true);
		expect(r.pt).toBe(MIN_PT.md);
		// 6.5 pt -> 0.65 mm per char: 30 chars (29 + "…") fit in 20 mm
		expect(Array.from(r.text)).toHaveLength(30);
	});
});
