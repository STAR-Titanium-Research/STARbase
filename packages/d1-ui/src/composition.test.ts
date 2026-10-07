import { describe, expect, it } from 'vitest';
import { BALANCE_COLOR, PALETTE, buildComposition, compositionAria, toElements } from './composition';

describe('toElements', () => {
	it('parses numeric strings and sorts heaviest first, unspecified last', () => {
		const out = toElements([
			{ symbol: 'Cr', weight_percent: '1.5' },
			{ symbol: 'Ni', weight_percent: null },
			{ symbol: 'Mo', weight_percent: 10 },
		]);
		expect(out.map((e) => e.symbol)).toEqual(['Mo', 'Cr', 'Ni']);
		expect(out[1].wt).toBe(1.5);
		expect(out[2].wt).toBeNull();
	});

	it('names a row with no symbol "?"', () => {
		expect(toElements([{ weight_percent: 1 }])[0].symbol).toBe('?');
	});
});

describe('buildComposition', () => {
	it('adds a balance segment that fills the bar to 100%', () => {
		const c = buildComposition(toElements([{ symbol: 'Al', weight_percent: 6 }, { symbol: 'V', weight_percent: 4 }]));
		expect(c.specifiedSum).toBe(10);
		expect(c.overspecified).toBe(false);
		expect(c.segments.map((s) => s.symbol)).toEqual(['Al', 'V', 'Bal.']);
		expect(c.segments.reduce((s, x) => s + x.widthPct, 0)).toBeCloseTo(100);
		const balance = c.segments.at(-1)!;
		expect(balance.color).toBe(BALANCE_COLOR);
		expect(balance.pctLabel).toBe('90.0 wt%');
		expect(c.segments[0].color).toBe(PALETTE[0]);
	});

	it('uses two decimals below 1 wt%', () => {
		const c = buildComposition(toElements([{ symbol: 'C', weight_percent: 0.08 }]));
		expect(c.segments[0].pctLabel).toBe('0.08 wt%');
	});

	it('normalises an over-specified composition and omits the balance', () => {
		const c = buildComposition(toElements([{ symbol: 'A', weight_percent: 80 }, { symbol: 'B', weight_percent: 40 }]));
		expect(c.overspecified).toBe(true);
		expect(c.segments.map((s) => s.symbol)).toEqual(['A', 'B']);
		expect(c.segments.reduce((s, x) => s + x.widthPct, 0)).toBeCloseTo(100);
	});

	it('has no segments when no element has a weight', () => {
		const c = buildComposition(toElements([{ symbol: 'Fe', weight_percent: null }]));
		expect(c.specifiedSum).toBe(0);
		expect(c.segments).toEqual([]);
	});

	it('has no balance when the elements fill the bar exactly', () => {
		const c = buildComposition(toElements([{ symbol: 'A', weight_percent: 100 }]));
		expect(c.segments.map((s) => s.symbol)).toEqual(['A']);
	});

	it('cycles the palette', () => {
		const rows = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({ symbol: `E${i}`, weight_percent: 1 }));
		const c = buildComposition(toElements(rows));
		expect(c.segments[PALETTE.length].color).toBe(PALETTE[0]);
	});
});

describe('compositionAria', () => {
	it('lists each segment', () => {
		const c = buildComposition(toElements([{ symbol: 'Al', weight_percent: 50 }]));
		expect(compositionAria(c.segments)).toBe('Composition: Al 50.0 wt%, Balance (matrix) 50.0 wt%');
	});
});
