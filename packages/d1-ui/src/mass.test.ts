import { describe, expect, it } from 'vitest';
import { estimateMassGrams, volumeMm3 } from './mass';

describe('volumeMm3', () => {
	it('disc: pi r^2 t, falling back to length when there is no thickness', () => {
		expect(volumeMm3({ form: 'disc', diameter_mm: 20, thickness_mm: 5 })).toBeCloseTo(Math.PI * 100 * 5);
		expect(volumeMm3({ form: 'disc', diameter_mm: 20, length_mm: 4 })).toBeCloseTo(Math.PI * 100 * 4);
	});

	it('round bar and cylinders (including legacy free-text forms): pi r^2 L', () => {
		const expected = Math.PI * 100 * 50;
		expect(volumeMm3({ form: 'round_bar', diameter_mm: 20, length_mm: 50 })).toBeCloseTo(expected);
		expect(volumeMm3({ form: 'cylinder', diameter_mm: 20, length_mm: 50 })).toBeCloseTo(expected);
		expect(volumeMm3({ form: 'Cylindrical', diameter_mm: 20, length_mm: 50 })).toBeCloseTo(expected);
		expect(volumeMm3({ form: 'rod', diameter_mm: 20, length_mm: 50 })).toBeCloseTo(expected);
	});

	it('box-like forms: w x L x t', () => {
		expect(volumeMm3({ form: 'plate', width_mm: 10, length_mm: 20, thickness_mm: 2 })).toBe(400);
		expect(volumeMm3({ form: 'bend_bar', width_mm: 15, length_mm: 100, thickness_mm: 10 })).toBe(15000);
	});

	it('is null when a dimension is missing, zero, or the form has no shape', () => {
		expect(volumeMm3({ form: 'plate', width_mm: 10, length_mm: 20 })).toBeNull();
		expect(volumeMm3({ form: 'disc', diameter_mm: 0, thickness_mm: 5 })).toBeNull();
		expect(volumeMm3({ form: 'powder', diameter_mm: 5, length_mm: 5 })).toBeNull();
		expect(volumeMm3({ form: null })).toBeNull();
	});
});

describe('estimateMassGrams', () => {
	it('converts mm^3 to cm^3 and applies the density', () => {
		// 10 x 20 x 5 mm = 1 cm^3 of 4.43 g/cm^3 titanium
		expect(estimateMassGrams({ form: 'block', width_mm: 10, length_mm: 20, thickness_mm: 5 }, 4.43)).toBeCloseTo(4.43);
	});

	it('is null without a density or a shape', () => {
		expect(estimateMassGrams({ form: 'block', width_mm: 10, length_mm: 20, thickness_mm: 5 }, null)).toBeNull();
		expect(estimateMassGrams({ form: 'other' }, 7.8)).toBeNull();
	});
});
