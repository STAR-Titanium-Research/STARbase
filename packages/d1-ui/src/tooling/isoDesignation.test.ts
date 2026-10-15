import { describe, expect, it } from 'vitest';
import { parseIsoDesignation } from './isoDesignation';

describe('parseIsoDesignation', () => {
	it('reads CNMG 12 04 08-MF (the seed designation)', () => {
		const iso = parseIsoDesignation('CNMG 12 04 08-MF')!;
		expect(iso.shape).toBe('C');
		expect(iso.icMm).toBeCloseTo(12.7, 3);
		expect(iso.thicknessMm).toBeCloseTo(4.76, 3);
		expect(iso.noseRadiusMm).toBeCloseTo(0.8, 3);
		expect(iso.clearanceDeg).toBe(0);
		expect(iso.doubleSided).toBe(true);
		expect(iso.hole).toBe('cylindrical');
		expect(iso.chipbreaker).toBe('MF');
	});

	it('reads the packed form and lower case the same way', () => {
		const a = parseIsoDesignation('CNMG120408-PM')!;
		const b = parseIsoDesignation('cnmg 12 04 08-pm')!;
		expect(a.chipbreaker).toBe('PM');
		expect({ ...b, raw: a.raw }).toEqual(a);
	});

	it('keeps the raw text it was given', () => {
		expect(parseIsoDesignation('CNMG 12 04 08-MF')!.raw).toBe('CNMG 12 04 08-MF');
	});

	it('reads CCMT 09 T3 04 (positive clearance, countersunk, one face)', () => {
		const iso = parseIsoDesignation('CCMT09T304')!;
		expect(iso.shape).toBe('C');
		expect(iso.icMm).toBeCloseTo(9.525, 3);
		expect(iso.thicknessMm).toBeCloseTo(3.97, 3);
		expect(iso.noseRadiusMm).toBeCloseTo(0.4, 3);
		expect(iso.clearanceDeg).toBe(7);
		expect(iso.doubleSided).toBe(false);
		expect(iso.hole).toBe('countersunk');
		expect(iso.chipbreaker).toBeNull();
	});

	it('accepts spaces inside the size block and a chipbreaker', () => {
		const iso = parseIsoDesignation('CCMT 09 T3 08-MF')!;
		expect(iso.thicknessMm).toBeCloseTo(3.97, 3);
		expect(iso.noseRadiusMm).toBeCloseTo(0.8, 3);
		expect(iso.chipbreaker).toBe('MF');
	});

	it('accepts a missing chipbreaker suffix', () => {
		expect(parseIsoDesignation('CNMG120408')!.chipbreaker).toBeNull();
	});

	it('maps every shape letter in the seed list', () => {
		const shape = (s: string) => parseIsoDesignation(s)!.shape;
		expect(shape('TNMG160408')).toBe('T');
		expect(shape('SNMG120408')).toBe('S');
		expect(shape('DCMT11T304')).toBe('D');
		expect(shape('VCMT160404')).toBe('V');
		expect(shape('WNMG080408')).toBe('W');
		expect(shape('RCMT1204M0')).toBe('R');
	});

	it.each([
		['CNMG120408', 12.7],
		['CNMG090308', 9.525],
		['CCMT060204', 6.35],
		['DCMT11T304', 9.525],
		['DNMG150408', 12.7],
		['SNMG090408', 9.525],
		['SNMG120408', 12.7],
		['SNMG150608', 15.875],
		['SNMG190612', 19.05],
		['TNMG110304', 6.35],
		['TNMG160408', 9.525],
		['TNMG220408', 12.7],
		['VCMT110304', 6.35],
		['VCMT160404', 9.525],
		['WNMG060408', 9.525],
		['WNMG080408', 12.7],
	])('%s has IC %f mm', (text, ic) => {
		expect(parseIsoDesignation(text)!.icMm).toBeCloseTo(ic, 3);
	});

	it('takes a round insert\'s size code as its diameter in mm', () => {
		const iso = parseIsoDesignation('RCMT1204M0')!;
		expect(iso.icMm).toBe(12);
		expect(iso.noseRadiusMm).toBeNull(); // M0 = round, no nose radius
		expect(iso.thicknessMm).toBeCloseTo(4.76, 3);
		expect(parseIsoDesignation('RCMT0803M0')!.icMm).toBe(8);
	});

	it('falls back to the edge-length relation for sizes not in the table', () => {
		// S 25 → 25.4 (1 inch), snapped to the 1/16 inch grid
		expect(parseIsoDesignation('SNMG250712')!.icMm).toBeCloseTo(25.4, 3);
		const odd = parseIsoDesignation('CNMG270712')!;
		expect(odd.icMm).toBeGreaterThan(24);
		expect(odd.icMm).toBeLessThan(28);
	});

	it.each([
		['01', 1.59], ['T1', 1.98], ['02', 2.38], ['T2', 2.78], ['03', 3.18], ['T3', 3.97],
		['04', 4.76], ['05', 5.56], ['06', 6.35], ['07', 7.94], ['09', 9.52],
	])('thickness code %s is %f mm', (code, mm) => {
		expect(parseIsoDesignation(`CNMG12${code}08`)!.thicknessMm).toBeCloseTo(mm, 3);
	});

	it.each([['00', 0], ['04', 0.4], ['08', 0.8], ['12', 1.2], ['16', 1.6]])('nose radius code %s is %f mm', (code, mm) => {
		expect(parseIsoDesignation(`CNMG1204${code}`)!.noseRadiusMm).toBeCloseTo(mm, 3);
	});

	it.each([['N', 0], ['A', 3], ['B', 5], ['C', 7], ['D', 15], ['E', 20], ['F', 25], ['G', 30], ['P', 11], ['O', 0]])(
		'clearance letter %s is %f degrees',
		(letter, deg) => {
			expect(parseIsoDesignation(`C${letter}MG120408`)!.clearanceDeg).toBe(deg);
		},
	);

	it.each([
		['A', 'cylindrical', true], ['G', 'cylindrical', true], ['M', 'cylindrical', false],
		['N', 'none', true], ['R', 'none', false], ['F', 'none', true],
		['T', 'countersunk', false], ['W', 'countersunk', false], ['Q', 'countersunk', true], ['U', 'countersunk', true],
	])('type letter %s is %s hole, double-sided when clearance is N: %s', (letter, hole, two) => {
		const iso = parseIsoDesignation(`CNM${letter}120408`)!;
		expect(iso.hole).toBe(hole);
		expect(iso.doubleSided).toBe(two);
	});

	it('is single-sided whenever the clearance is positive', () => {
		expect(parseIsoDesignation('CCMG120408')!.doubleSided).toBe(false);
	});

	it('reads a designation with no nose radius or thickness-only tail', () => {
		const iso = parseIsoDesignation('CNMG1204')!;
		expect(iso.noseRadiusMm).toBeNull();
		expect(iso.thicknessMm).toBeCloseTo(4.76, 3);
	});

	it.each([null, undefined, '', '   ', 'garbage', 'H13A', 'XNMG120408', 'CNMG', '12345678', 'BOX-H13A-001'])(
		'returns null for %j',
		(text) => {
			expect(parseIsoDesignation(text as string | null | undefined)).toBeNull();
		},
	);
});
