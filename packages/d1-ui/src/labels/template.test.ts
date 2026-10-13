import { describe, expect, it } from 'vitest';
import { templateFromRow, validateTemplate } from './template';
import { QR_KEYS } from './types';

// The four seeds of the label_templates migration, as Directus returns them (numerics as strings).
const A4_4X5 = {
	id: 'a', name: 'A4 4×5', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 4, rows: 5,
	label_width_mm: '52.5', label_height_mm: '59.4', margin_top_mm: '0', margin_left_mm: '0', gap_x_mm: '0', gap_y_mm: '0',
	padding_mm: '2', arrangement: 'qr_top', qr_size_mm: null, is_default: true,
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm', bold: false }], qr_fields: [],
};
const L7160 = {
	id: 'b', name: 'L7160 21-up', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 3, rows: 7,
	label_width_mm: '63.5', label_height_mm: '38.1', margin_top_mm: '15.15', margin_left_mm: '7.25', gap_x_mm: '2.54', gap_y_mm: '0',
	arrangement: 'qr_left', fields: [{ key: 'sample_code', size: 'lg', bold: true }],
};
const SINGLE_50X25 = {
	id: 'c', name: '50×25 single', media: 'roll', page_width_mm: 50, page_height_mm: 25, columns: 1, rows: 1,
	label_width_mm: 50, label_height_mm: 25, arrangement: 'qr_left', fields: [{ key: 'sample_code', size: 'lg', bold: true }],
};
const BROTHER = {
	id: 'd', name: 'Brother DK-22205 62 mm', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1,
	label_width_mm: 62, label_height_mm: 30, arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'short_id', size: 'md' }, { key: 'nickname', size: 'md' }],
};

describe('templateFromRow', () => {
	it('turns numeric strings into numbers and camelCases', () => {
		const t = templateFromRow(L7160);
		expect(t.pageWidthMm).toBe(210);
		expect(t.labelWidthMm).toBe(63.5);
		expect(t.marginTopMm).toBe(15.15);
		expect(t.gapXMm).toBe(2.54);
		expect(t.columns).toBe(3);
		expect(t.arrangement).toBe('qr_left');
	});
	it('fills defaults', () => {
		const t = templateFromRow(L7160);
		expect(t.paddingMm).toBe(2);
		expect(t.gapYMm).toBe(0);
		expect(t.qrSizeMm).toBeNull();
		expect(t.qrFields).toEqual([...QR_KEYS]); // an empty qr_fields means all
		expect(templateFromRow({ ...L7160, qr_fields: null }).qrFields).toEqual([...QR_KEYS]);
		expect(t.isDefault).toBe(false);
		expect(t.description).toBeNull();
		expect(t.userCreated).toBeNull();
		expect(templateFromRow(BROTHER).fields[1]).toEqual({ key: 'short_id', size: 'md', bold: false });
	});
	it('keeps the audit columns and a numeric qr size', () => {
		const t = templateFromRow({ ...A4_4X5, qr_size_mm: '30', qr_fields: ['material', 'date'], user_created: 'u1', date_created: '2026-10-01T00:00:00Z' });
		expect(t.qrSizeMm).toBe(30);
		expect(t.qrFields).toEqual(['material', 'date']);
		expect(t.userCreated).toBe('u1');
		expect(t.dateCreated).toBe('2026-10-01T00:00:00Z');
		expect(t.isDefault).toBe(true);
	});
	it('parses fields and qr_fields given as JSON text, and drops unknown entries', () => {
		const t = templateFromRow({
			...A4_4X5,
			fields: JSON.stringify([{ key: 'material', size: 'huge', bold: 1 }, { key: 'bogus' }, 'date', null]),
			qr_fields: '["nickname","nope","sample_code","owner_email"]',
		});
		expect(t.fields).toEqual([{ key: 'material', size: 'md', bold: false }]);
		expect(t.qrFields).toEqual(['nickname', 'owner_email']);
	});
	it('throws a readable error for a row that cannot be a template', () => {
		expect(() => templateFromRow({ ...A4_4X5, label_width_mm: 'wide' })).toThrow(/label_width_mm/);
		expect(() => templateFromRow({ ...A4_4X5, arrangement: 'diagonal' })).toThrow(/arrangement/);
		expect(() => templateFromRow({ ...A4_4X5, media: 'tape' })).toThrow(/media/);
		expect(() => templateFromRow({ ...A4_4X5, columns: null })).toThrow(/columns/);
	});
});

describe('validateTemplate', () => {
	it('accepts all four seeds exactly as migrated (float edges included)', () => {
		for (const row of [A4_4X5, L7160, SINGLE_50X25, BROTHER]) expect(validateTemplate(templateFromRow(row)), row.name).toEqual([]);
	});
	it('flags a grid that runs off the page', () => {
		const wide = templateFromRow({ ...A4_4X5, label_width_mm: 53 });
		expect(validateTemplate(wide).join(' ')).toMatch(/wider than the page/);
		const tall = templateFromRow({ ...A4_4X5, margin_top_mm: 1 });
		expect(validateTemplate(tall).join(' ')).toMatch(/taller than the page/);
	});
	it('flags a roll that is not one label', () => {
		expect(validateTemplate(templateFromRow({ ...SINGLE_50X25, columns: 2 })).join(' ')).toMatch(/roll/);
	});
	it('flags non-positive sizes, bad counts and a missing name', () => {
		const t = templateFromRow(A4_4X5);
		expect(validateTemplate({ ...t, name: '  ' }).join(' ')).toMatch(/name/);
		expect(validateTemplate({ ...t, labelWidthMm: 0 }).join(' ')).toMatch(/label width/i);
		expect(validateTemplate({ ...t, columns: 0 }).join(' ')).toMatch(/columns/i);
		expect(validateTemplate({ ...t, rows: 1.5 }).join(' ')).toMatch(/rows/i);
		expect(validateTemplate({ ...t, paddingMm: -1 }).join(' ')).toMatch(/padding/i);
		expect(validateTemplate({ ...t, gapXMm: Number.NaN }).join(' ')).toMatch(/gap/i);
	});
	it('flags padding that leaves no room, and a QR bigger than the label', () => {
		const t = templateFromRow(A4_4X5);
		expect(validateTemplate({ ...t, paddingMm: 30 }).join(' ')).toMatch(/padding/i);
		expect(validateTemplate({ ...t, qrSizeMm: 80 }).join(' ')).toMatch(/QR/);
		expect(validateTemplate({ ...t, qrSizeMm: 0 }).join(' ')).toMatch(/QR/);
	});
	it('flags text-only with no fields', () => {
		const t = templateFromRow({ ...A4_4X5, arrangement: 'text_only', fields: [] });
		expect(validateTemplate(t).join(' ')).toMatch(/field/);
	});
});
