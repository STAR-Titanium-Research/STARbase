import { describe, expect, it } from 'vitest';
import { layoutLabel } from './layout';
import { templateFromRow } from './template';
import type { LabelSample } from './types';

// Seeds built from the plan's numbers.
const DK_22205 = templateFromRow({
	name: 'Brother DK-22205 62 mm', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1, label_width_mm: 62,
	label_height_mm: 30, arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'short_id', size: 'md' }, { key: 'nickname', size: 'md' }],
});
const L7160 = templateFromRow({
	name: 'L7160 21-up', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 3, rows: 7, label_width_mm: '63.5',
	label_height_mm: '38.1', margin_top_mm: '15.15', margin_left_mm: '7.25', gap_x_mm: '2.54', arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm' }],
});
const A4_4X5 = templateFromRow({
	name: 'A4 4×5', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 4, rows: 5, label_width_mm: '52.5',
	label_height_mm: '59.4', arrangement: 'qr_top',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm' }],
});

const sample = (over: Partial<LabelSample> = {}): LabelSample => ({
	id: 'u', code: '1234-AA-MM-2026-10-12', shortId: '1a2b3c4d', nickname: null, material: null, date: null, ownerInitials: null, ...over,
});

describe('qr_left automatic QR size', () => {
	it.each([
		['DK-22205', DK_22205],
		['L7160', L7160],
	])('does not clip a 21-character real-style code on %s', (_name, t) => {
		const lay = layoutLabel(sample(), t);
		expect(lay.clipped).toBe(false);
		expect(lay.lines[0].text).toBe('1234-AA-MM-2026-10-12');
	});
	it('gives the QR code the space the text does not need, never less than the floor', () => {
		const lay = layoutLabel(sample({ code: 'S-1' }), DK_22205);
		expect(lay.qr!.w).toBe(26); // the whole inner height: the text is short
		const long = layoutLabel(sample(), DK_22205);
		expect(long.qr!.w).toBeLessThan(26);
		expect(long.qr!.w).toBeGreaterThanOrEqual(0.35 * 26 - 0.01);
	});
	it('still clips when even the floor does not leave room', () => {
		expect(layoutLabel(sample({ code: 'X'.repeat(60) }), DK_22205).clipped).toBe(true);
	});
});

describe('qr_top', () => {
	it('keeps the QR above the text', () => {
		const lay = layoutLabel(sample({ nickname: 'n' }), A4_4X5);
		expect(lay.lines[0].y).toBeGreaterThanOrEqual(lay.qr!.y + lay.qr!.h);
	});
});
