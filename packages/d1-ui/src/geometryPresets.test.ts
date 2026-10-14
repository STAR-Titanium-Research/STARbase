import { describe, expect, it } from 'vitest';
import { FORM_FIELDS, PRESETS, matchingPreset, presetDims, presetLabel, presetsFor } from '../../../core/extensions/d1-geometry-preview/src/geometry';

describe('coupon presets (decision 15)', () => {
	it('tensile coupon offers the four named standards with their dimensions', () => {
		const byId = Object.fromEntries(presetsFor('tensile_coupon').map((p) => [p.id, p.dims]));
		expect(byId).toEqual({
			astm_e8_sheet: { gauge_length_mm: 50, gauge_width_mm: 12.5, length_mm: 200, width_mm: 20 },
			astm_e8_subsize: { gauge_length_mm: 25, gauge_width_mm: 6, length_mm: 100, width_mm: 10 },
			iso_6892_1_type1: { gauge_length_mm: 50, gauge_width_mm: 12.5, length_mm: 200, width_mm: 20 },
			iso_6892_1_type2: { gauge_length_mm: 80, gauge_width_mm: 20, length_mm: 250, width_mm: 30 },
		});
		expect(presetsFor('tensile_coupon').map((p) => p.text)).toEqual(['ASTM E8/E8M sheet', 'ASTM E8/E8M subsize', 'ISO 6892-1 type 1', 'ISO 6892-1 type 2']);
	});
	it('the bend bar offers the plain bar', () => {
		expect(presetsFor('bend_bar')).toHaveLength(1);
		expect(presetDims('bend_bar', 'plain_bar')).toEqual({ length_mm: 100, width_mm: 15 });
	});
	it('the fatigue specimen offers two typical flat specimens, thickness left to the user', () => {
		expect(Object.fromEntries(presetsFor('fatigue_specimen').map((p) => [p.id, p.dims]))).toEqual({
			astm_e466_flat: { gauge_length_mm: 25, gauge_width_mm: 10, length_mm: 100, width_mm: 20 },
			iso_1099_flat: { gauge_length_mm: 30, gauge_width_mm: 12, length_mm: 120, width_mm: 25 },
		});
		expect(presetsFor('fatigue_specimen').map((p) => p.text)).toEqual(['ASTM E466 flat (typical)', 'ISO 1099 flat (typical)']);
		expect(FORM_FIELDS.fatigue_specimen).toEqual(FORM_FIELDS.tensile_coupon);
	});
	it('the Charpy specimen offers the full size and three sub-sizes, thickness included', () => {
		expect(presetsFor('charpy_specimen').map((p) => p.dims)).toEqual([
			{ length_mm: 55, width_mm: 10, thickness_mm: 10 },
			{ length_mm: 55, width_mm: 10, thickness_mm: 7.5 },
			{ length_mm: 55, width_mm: 10, thickness_mm: 5 },
			{ length_mm: 55, width_mm: 10, thickness_mm: 2.5 },
		]);
		expect(presetLabel(presetsFor('charpy_specimen')[0])).toBe('Full size 55 × 10 × 10');
		expect(FORM_FIELDS.charpy_specimen).toEqual(['length_mm', 'width_mm', 'thickness_mm']);
		expect(matchingPreset('charpy_specimen', { length_mm: 55, width_mm: 10, thickness_mm: '5.0' })).toBe('sub_5');
		expect(matchingPreset('charpy_specimen', { length_mm: 55, width_mm: 10, thickness_mm: 6 })).toBeNull();
	});
	it('only the Charpy specimen presets the thickness, and every preset sets only dimensions the form shows', () => {
		for (const [form, list] of Object.entries(PRESETS)) {
			for (const p of list) {
				if (form !== 'charpy_specimen') expect(Object.keys(p.dims)).not.toContain('thickness_mm');
				for (const k of Object.keys(p.dims)) expect(FORM_FIELDS[form], `${form}.${p.id}.${k}`).toContain(k);
			}
		}
	});
	it('ids are unique within a form; other forms (and no form) have no presets', () => {
		for (const list of Object.values(PRESETS)) expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
		for (const f of ['disc', 'plate', 'other', '', null, undefined]) expect(presetsFor(f)).toEqual([]);
		expect(presetsFor('Tensile_Coupon')).toHaveLength(4);
	});
	it('presetDims returns a copy, and null for an unknown id', () => {
		const d = presetDims('tensile_coupon', 'astm_e8_sheet')!;
		d.length_mm = 1;
		expect(presetDims('tensile_coupon', 'astm_e8_sheet')!.length_mm).toBe(200);
		expect(presetDims('tensile_coupon', 'nope')).toBeNull();
		expect(presetDims('disc', 'astm_e8_sheet')).toBeNull();
	});
	it('presetLabel lists the dimensions', () => {
		expect(presetLabel(presetsFor('tensile_coupon')[0])).toBe('ASTM E8/E8M sheet (L 200, W 20, G 50, Wg 12.5 mm)');
	});
});

describe('matchingPreset', () => {
	const sheet = { length_mm: 200, width_mm: 20, gauge_length_mm: 50, gauge_width_mm: 12.5, thickness_mm: 3 };
	it('finds the standard the dimensions equal, whatever the thickness', () => {
		expect(matchingPreset('tensile_coupon', sheet)).toBe('astm_e8_sheet');
		expect(matchingPreset('tensile_coupon', { ...sheet, thickness_mm: null })).toBe('astm_e8_sheet');
		expect(matchingPreset('tensile_coupon', { length_mm: 250, width_mm: 30, gauge_length_mm: 80, gauge_width_mm: 20 })).toBe('iso_6892_1_type2');
	});
	it('reads numeric strings (Directus sends decimals as strings)', () => {
		expect(matchingPreset('tensile_coupon', { length_mm: '100.00', width_mm: '10', gauge_length_mm: '25', gauge_width_mm: '6.0' })).toBe('astm_e8_subsize');
	});
	it('is null once a dimension is edited, when one is empty, or for a form without presets', () => {
		expect(matchingPreset('tensile_coupon', { ...sheet, length_mm: 201 })).toBeNull();
		expect(matchingPreset('tensile_coupon', { ...sheet, gauge_width_mm: null })).toBeNull();
		expect(matchingPreset('tensile_coupon', { ...sheet, gauge_width_mm: '' })).toBeNull();
		expect(matchingPreset('tensile_coupon', {})).toBeNull();
		expect(matchingPreset('plate', sheet)).toBeNull();
		expect(matchingPreset(null, sheet)).toBeNull();
	});
});
