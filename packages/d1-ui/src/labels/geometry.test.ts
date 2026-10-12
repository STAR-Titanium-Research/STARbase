import { describe, expect, it } from 'vitest';
import { paginate, slotPositions } from './geometry';
import { templateFromRow } from './template';
import type { LabelSample } from './types';

const A4_4X5 = templateFromRow({
	name: 'A4', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 4, rows: 5, label_width_mm: '52.5',
	label_height_mm: '59.4', arrangement: 'qr_top',
});
const L7160 = templateFromRow({
	name: 'L7160', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 3, rows: 7, label_width_mm: '63.5',
	label_height_mm: '38.1', margin_top_mm: '15.15', margin_left_mm: '7.25', gap_x_mm: '2.54', arrangement: 'qr_left',
});
const ROLL = templateFromRow({
	name: 'Roll', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1, label_width_mm: 62, label_height_mm: 30,
	arrangement: 'qr_left',
});

const sample = (n: number): LabelSample => ({
	id: `id-${n}`, code: `S-${n}`, shortId: String(n).padStart(8, '0'), nickname: null, material: null, date: null, ownerInitials: null,
});
const codes = (pages: (LabelSample | null)[][]) => pages.map((p) => p.map((s) => (s ? s.code : null)));

describe('slotPositions', () => {
	it('lays the A4 4x5 sheet edge to edge, row-major', () => {
		const p = slotPositions(A4_4X5);
		expect(p).toHaveLength(20);
		expect(p[0]).toEqual({ x: 0, y: 0 });
		expect(p[1].x).toBeCloseTo(52.5, 5);
		expect(p[3].x).toBeCloseTo(157.5, 5);
		expect(p[4]).toEqual({ x: 0, y: 59.4 });
		expect(p[19].x).toBeCloseTo(157.5, 5);
		expect(p[19].y).toBeCloseTo(237.6, 5);
	});
	it('uses the L7160 margins and gap, with no centring', () => {
		const p = slotPositions(L7160);
		expect(p).toHaveLength(21);
		expect(p[0].x).toBeCloseTo(7.25, 5);
		expect(p[0].y).toBeCloseTo(15.15, 5);
		expect(p[1].x).toBeCloseTo(73.29, 5);
		expect(p[2].x).toBeCloseTo(139.33, 5);
		expect(p[3].x).toBeCloseTo(7.25, 5);
		expect(p[3].y).toBeCloseTo(53.25, 5);
		expect(p[20].y).toBeCloseTo(15.15 + 6 * 38.1, 5);
	});
	it('puts a roll label at its margins (0 by default)', () => {
		expect(slotPositions(ROLL)).toEqual([{ x: 0, y: 0 }]);
	});
});

describe('paginate', () => {
	const five = [1, 2, 3, 4, 5].map(sample);
	it('fills pages row by row and does not pad the last one', () => {
		const pages = paginate(five, { copies: 1, start: 1 }, { ...A4_4X5, columns: 2, rows: 2 });
		expect(codes(pages)).toEqual([['S-1', 'S-2', 'S-3', 'S-4'], ['S-5']]);
	});
	it('skips slots before the start position on the first page only', () => {
		const t = { ...A4_4X5, columns: 2, rows: 2 };
		expect(codes(paginate(five, { copies: 1, start: 3 }, t))).toEqual([[null, null, 'S-1', 'S-2'], ['S-3', 'S-4', 'S-5']]);
	});
	it('repeats each sample next to itself for copies', () => {
		const t = { ...A4_4X5, columns: 2, rows: 2 };
		expect(codes(paginate([sample(1), sample(2)], { copies: 3, start: 1 }, t))).toEqual([['S-1', 'S-1', 'S-1', 'S-2'], ['S-2', 'S-2']]);
	});
	it('handles 21 across a full L7160 page and spills to the next', () => {
		const many = Array.from({ length: 22 }, (_, i) => sample(i + 1));
		const pages = paginate(many, { copies: 1, start: 1 }, L7160);
		expect(pages.map((p) => p.length)).toEqual([21, 1]);
	});
	it('a roll gives one label per page and ignores start', () => {
		const pages = paginate([sample(1), sample(2)], { copies: 2, start: 5 }, ROLL);
		expect(codes(pages)).toEqual([['S-1'], ['S-1'], ['S-2'], ['S-2']]);
	});
	it('clamps a bad start and copies to something printable', () => {
		const t = { ...A4_4X5, columns: 2, rows: 2 };
		expect(codes(paginate([sample(1)], { copies: 0, start: 99 }, t))).toEqual([[null, null, null, 'S-1']]);
		expect(codes(paginate([sample(1)], { copies: Number.NaN, start: 0 }, t))).toEqual([['S-1']]);
		expect(codes(paginate([sample(1)], { copies: 1.9, start: 1.2 }, t))).toEqual([['S-1']]);
	});
	it('gives no pages for no samples, even with a start offset', () => {
		expect(paginate([], { copies: 1, start: 4 }, A4_4X5)).toEqual([]);
	});
});
