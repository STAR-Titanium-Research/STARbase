import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHOICES, choiceKindFor, choiceLabel, type ChoiceKind } from './choiceLabels';
import { FORMS } from '../../../core/extensions/d1-geometry-preview/src/geometry';
import { humanise } from './status';

describe('choiceLabel', () => {
	it('gives the label of a stored value', () => {
		expect(choiceLabel('geometry', 'tensile_coupon')).toBe('Tensile coupon (ISO 6892)');
		expect(choiceLabel('geometry', 'bend_bar')).toBe('Bend bar (ISO 7438)');
		expect(choiceLabel('geometry', 'fatigue_specimen')).toBe('Fatigue specimen');
		expect(choiceLabel('geometry', 'charpy_specimen')).toBe('Charpy specimen (ISO 148-1)');
		expect(choiceLabel('surfaceFinish', 'medium_machined')).toBe('Medium machined');
		expect(choiceLabel('surfaceFinish', 'as_produced')).toBe('As produced');
		expect(choiceLabel('equipmentType', 'Sample_Prep')).toBe('Sample prep');
		expect(choiceLabel('equipmentType', 'Machining')).toBe('Machining');
		expect(choiceLabel('machiningSubtype', 'MT-F')).toBe('Turning – Facing');
		expect(choiceLabel('machiningSubtype', 'MM-D')).toBe('Milling – Drilling');
	});
	it('falls back to a humanised string for an unknown value', () => {
		expect(choiceLabel('geometry', 'cylindrical_rod')).toBe('Cylindrical rod');
		expect(choiceLabel('surfaceFinish', 'shot_peened')).toBe('Shot peened');
		expect(choiceLabel('equipmentType', 'Laser_Cutter')).toBe('Laser Cutter');
		expect(choiceLabel('machiningSubtype', 'MT-X')).toBe('MT-X');
		expect(choiceLabel('machiningSubtype', 'other')).toBe('Other');
	});
	it('gives nothing for an empty value, and trims', () => {
		for (const v of [null, undefined, '', '   ']) expect(choiceLabel('geometry', v)).toBe('');
		expect(choiceLabel('geometry', ' disc ')).toBe('Disc');
	});
	it('uses the same fallback rule as humanise', () => {
		for (const v of ['pending_processing', 'a_b_c', 'Foo', 'x']) expect(choiceLabel('geometry', v)).toBe(humanise(v));
	});
});

describe('the tables', () => {
	const kinds = Object.keys(CHOICES) as ChoiceKind[];
	it('have unique values and non-empty labels', () => {
		for (const k of kinds) {
			const values = CHOICES[k].map((c) => c.value);
			expect(new Set(values).size, k).toBe(values.length);
			for (const c of CHOICES[k]) expect(c.text.trim(), `${k}.${c.value}`).not.toBe('');
		}
	});
	it('equipment types: all 30 stored values, and the Force App value stays', () => {
		expect(CHOICES.equipmentType).toHaveLength(30);
		expect(CHOICES.equipmentType.map((c) => c.value)).toContain('Machining');
		expect(CHOICES.equipmentType.map((c) => c.value)).not.toContain('AM');
	});
	it('sub-types: the twelve MT-/MM- codes, no "other"', () => {
		expect(CHOICES.machiningSubtype.map((c) => c.value)).toEqual(['MT-F', 'MT-R', 'MT-O', 'MT-G', 'MT-B', 'MT-H', 'MT-P', 'MT-D', 'MM-F', 'MM-R', 'MM-S', 'MM-D']);
	});
	it('geometry equals the sample creator list (one table in two homes, because the extension cannot import @d1/ui)', () => {
		expect(CHOICES.geometry.map((c) => ({ text: c.text, value: c.value }))).toEqual(FORMS);
	});
});

describe('choiceKindFor', () => {
	it('names the four columns and nothing else', () => {
		expect(choiceKindFor('physical_samples', 'form')).toBe('geometry');
		expect(choiceKindFor('physical_samples', 'surface_finish')).toBe('surfaceFinish');
		expect(choiceKindFor('equipment', 'equipment_type')).toBe('equipmentType');
		expect(choiceKindFor('manufacturing_operations', 'machining_operation_subtype')).toBe('machiningSubtype');
		expect(choiceKindFor('tools', 'form')).toBeNull();
		expect(choiceKindFor('physical_samples', 'location')).toBeNull();
	});
});

describe('the copy in d1-report', () => {
	it('is byte-identical to this one (scripts/sync_geometry.sh keeps it so)', () => {
		const a = readFileSync(new URL('./choiceLabels.ts', import.meta.url), 'utf8');
		const b = readFileSync(new URL('../../../core/extensions/d1-report/src/choiceLabels.ts', import.meta.url), 'utf8');
		expect(b).toBe(a);
	});
});
