import { describe, expect, it } from 'vitest';
import { normaliseEdgeLetter, placeEdge } from './edgePlacement';
import { resolveInsertGeometry } from './insertGeometry';

const geom = (iso: string, edge_count?: number) => resolveInsertGeometry({ iso_designation: iso, edge_count });

describe('normaliseEdgeLetter', () => {
	it.each([
		['A', 'A'], ['c', 'C'], ['fC', 'C'], ['FA', 'A'], ['fa', 'A'], [' fD ', 'D'], ['F', 'F'], ['f', 'F'], ['fF', 'F'],
	])('%j -> %j', (input, out) => {
		expect(normaliseEdgeLetter(input)).toBe(out);
	});

	it.each([null, undefined, '', '  ', '1', 'A1', 'fAB', 'f1', '-', 'AB'])('%j is unreadable', (input) => {
		expect(normaliseEdgeLetter(input as string | null | undefined)).toBeNull();
	});
});

describe('placeEdge', () => {
	const cnmg = geom('CNMG120408'); // acute corners 0 and 2, double-sided

	it('puts A and B on the top face, C and D under them (CNMG)', () => {
		expect(placeEdge(cnmg, 'A')).toEqual({ face: 'top', corner: 0 });
		expect(placeEdge(cnmg, 'B')).toEqual({ face: 'top', corner: 2 });
		expect(placeEdge(cnmg, 'C')).toEqual({ face: 'bottom', corner: 0 });
		expect(placeEdge(cnmg, 'D')).toEqual({ face: 'bottom', corner: 2 });
	});

	it('has no place for E on a CNMG', () => {
		expect(placeEdge(cnmg, 'E')).toBeNull();
	});

	it('has no place for C on a single-sided CCMT', () => {
		const ccmt = geom('CCMT09T304');
		expect(placeEdge(ccmt, 'A')).toEqual({ face: 'top', corner: 0 });
		expect(placeEdge(ccmt, 'B')).toEqual({ face: 'top', corner: 2 });
		expect(placeEdge(ccmt, 'C')).toBeNull();
	});

	it('strips the legacy f and accepts lower case', () => {
		expect(placeEdge(cnmg, 'fC')).toEqual({ face: 'bottom', corner: 0 });
		expect(placeEdge(cnmg, 'b')).toEqual({ face: 'top', corner: 2 });
	});

	it('numbers a TNMG A to F: three corners on each face', () => {
		const tnmg = geom('TNMG160408');
		expect(placeEdge(tnmg, 'C')).toEqual({ face: 'top', corner: 2 });
		expect(placeEdge(tnmg, 'D')).toEqual({ face: 'bottom', corner: 0 });
		expect(placeEdge(tnmg, 'F')).toEqual({ face: 'bottom', corner: 2 });
		expect(placeEdge(tnmg, 'G')).toBeNull();
	});

	it('numbers a SNMG A to H', () => {
		const snmg = geom('SNMG120408');
		expect(placeEdge(snmg, 'D')).toEqual({ face: 'top', corner: 3 });
		expect(placeEdge(snmg, 'H')).toEqual({ face: 'bottom', corner: 3 });
	});

	it('follows edge_count over the ISO rule', () => {
		expect(placeEdge(geom('CNMG120408', 2), 'C')).toBeNull();
	});

	it('returns null for junk', () => {
		expect(placeEdge(cnmg, null)).toBeNull();
		expect(placeEdge(cnmg, '')).toBeNull();
		expect(placeEdge(cnmg, '7')).toBeNull();
		expect(placeEdge(cnmg, 'AB')).toBeNull();
	});
});
