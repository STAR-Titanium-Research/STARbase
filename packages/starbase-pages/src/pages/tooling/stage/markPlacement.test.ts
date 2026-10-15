import { describe, expect, it } from 'vitest';
import { insertOutline, resolveInsertGeometry } from '@d1/ui';
import { buildReferenceMark } from './scene/insertMesh';
import { outline2d } from './outline2d';
import { faceClearance, MARK_MARGIN_MM, markDistance, markVertices } from './markPlacement';

const of = (iso: string, extra: Record<string, unknown> = {}) => {
	const geom = resolveInsertGeometry({ iso_designation: iso, ...extra });
	return { geom, outline: insertOutline(geom) };
};

const R390 = { iso_designation: null, type_code: 'R390-11 T3 08M-MM S30T', nose_radius_mm: 0.8, fixing_hole_diameter_mm: 2.8 };
const TYPES: Array<[string, string, Record<string, unknown>]> = [
	['CNMG', 'CNMG 12 04 08-MF', {}],
	['SNMG', 'SNMG 12 04 08', {}],
	['TNMG', 'TNMG 16 04 08', {}],
	['DNMG', 'DNMG 15 06 08', {}],
	['VBMT', 'VBMT 16 04 08', {}],
	['CCMT countersunk', 'CCMT 09 T3 04', {}],
	['RCMT round', 'RCMT1204M0', {}],
	['R390 milling', '', R390],
	['PCD CCGW', 'CCGW 09T3 04', { edge_count: 1, substrate: 'PCD' }],
	['polygon fallback', '???', { edge_count: 5 }],
];

describe('markDistance', () => {
	for (const [name, iso, extra] of TYPES) {
		it(`keeps the ${name} mark on the top face: inside the rim, clear of the hole, short of the corner`, () => {
			const { geom, outline } = of(iso, extra);
			const { size, centre, end } = markDistance(geom, outline)!;
			const r = geom.icMm / 2;
			const bevel = Math.min(0.15, geom.thicknessMm / 4, r / 8);
			const face = outline.points.map(([x, y]): [number, number] => [(x * (r - bevel)) / r, (y * (r - bevel)) / r]);
			for (const v of markVertices(outline.corners[0].bisectorDeg, size, centre)) {
				expect(faceClearance(face, v)).toBeGreaterThan(MARK_MARGIN_MM - 0.2);
			}
			if (geom.holeDiameterMm) {
				const rHole = Math.min(geom.holeDiameterMm / 2, r * 0.6);
				const opening = geom.holeCountersunk ? Math.min(rHole * 1.5, r * 0.75) : rHole;
				expect(centre - 0.4 * size).toBeGreaterThan(opening);
			}
			expect(end).toBeCloseTo(centre + 0.6 * size, 9);
			const c0 = outline.corners[0];
			expect(end).toBeLessThan(Math.hypot(c0.x, c0.y) + (geom.shape === 'R' ? 0 : geom.noseRadiusMm));
		});
	}

	it('is much bigger than the old 1 mm mark on a common insert, and grows with the insert', () => {
		const c = of('CNMG 12 04 08-MF');
		expect(markDistance(c.geom, c.outline)!.size).toBeGreaterThanOrEqual(2);
		const small = of('CCMT 06 02 04');
		const big = of('SNMG 19 06 08');
		expect(markDistance(big.geom, big.outline)!.size).toBeGreaterThan(markDistance(small.geom, small.outline)!.size);
	});

	it('tucks the mark in toward the hole on a tipped insert, leaving the wedge to the tip pad', () => {
		const tipped = of('CCGW 09T3 04', { edge_count: 1, substrate: 'PCD' });
		const plain = of('CCGW 09T3 04', { edge_count: 1 });
		const t = markDistance(tipped.geom, tipped.outline)!;
		const p = markDistance(plain.geom, plain.outline)!;
		expect(t.centre).toBeLessThan(p.centre);
		const tip = Math.hypot(tipped.outline.corners[0].x, tipped.outline.corners[0].y) + tipped.geom.noseRadiusMm;
		expect(tip - (t.end + 0.3)).toBeGreaterThanOrEqual(1.8 - 1e-6);
	});

	it('points along the bisector of a milling insert (the fillet centre), not along a fixed diagonal', () => {
		const { geom, outline } = of('', R390);
		expect(geom.shape).toBe('rect');
		const c0 = outline.corners[0];
		const { size, centre } = markDistance(geom, outline)!;
		const [tip] = markVertices(c0.bisectorDeg, size, centre);
		expect(Math.atan2(tip[1], tip[0])).toBeCloseTo(Math.atan2(c0.y, c0.x), 6);
	});
});

// A mark that fits is inside the face and clear of the hole; where none fits it is left out, never drawn outside.
describe('markDistance on small inserts', () => {
	const SMALL: Array<[string, string, Record<string, unknown>]> = [
		['RCMT 06 02 M0 (round, 6 mm, countersunk)', 'RCMT 06 02 M0', {}],
		['RCMT 06 02 M0 as the type_code spells it', 'RCMT0602M0', {}],
		['TCMT 06 02 04 (tiny triangle)', 'TCMT 06 02 04', {}],
		['TCMT 090204', 'TCMT090204', {}],
		['CCMT 03 02 02 (tiny)', 'CCMT 03 02 02', {}],
		['VCMT 08 02 04', 'VCMT 08 02 04', {}],
		['a 4 mm round', 'RCMT 04 T1 M0', {}],
		['a one-edge PCD tip', 'CCGW 06 02 04', { edge_count: 1, substrate: 'PCD' }],
	];
	for (const [name, iso, extra] of SMALL) {
		it(`never lands outside the face, or in the hole, on ${name}`, () => {
			const { geom, outline } = of(iso, extra);
			const placed = markDistance(geom, outline);
			if (!placed) return; // none fits: no mark is drawn (buildReferenceMark and the 2D drawing skip it)
			const r = geom.icMm / 2;
			const opening = geom.holeDiameterMm ? (geom.holeCountersunk ? Math.min(Math.min(geom.holeDiameterMm / 2, r * 0.6) * 1.5, r * 0.75) : Math.min(geom.holeDiameterMm / 2, r * 0.6)) : 0;
			for (const v of markVertices(outline.corners[0].bisectorDeg, placed.size, placed.centre)) {
				expect(faceClearance(outline.points, v)).toBeGreaterThan(0.1); // inside the outline, a margin from its edge
				expect(Math.hypot(v[0], v[1])).toBeGreaterThan(opening); // outside the hole
			}
			expect(placed.size).toBeGreaterThanOrEqual(0.35);
		});
	}

	it('returns null for a face with no room (a 3 or 4 mm round with its countersink), in 3D and in 2D', () => {
		for (const iso of ['RCMT 04 T1 M0', 'RCMT 03 02 M0']) {
			const { geom, outline } = of(iso);
			expect(markDistance(geom, outline)).toBeNull();
			expect(buildReferenceMark(geom, outline)).toBeNull();
			expect(outline2d(geom, outline).mark).toBe('');
		}
	});

	it('still draws a small mark inside a 6 mm round, rather than none or one outside', () => {
		const { geom, outline } = of('RCMT 06 02 M0');
		const placed = markDistance(geom, outline)!;
		expect(placed).not.toBeNull();
		expect(placed.size).toBeLessThan(1);
		expect(buildReferenceMark(geom, outline)).not.toBeNull();
		expect(outline2d(geom, outline).mark.startsWith('M')).toBe(true);
	});
});

describe('faceClearance', () => {
	const square: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
	it('is the distance to the nearest side inside, and negative outside', () => {
		expect(faceClearance(square, [0, 0])).toBeCloseTo(1, 9);
		expect(faceClearance(square, [0.5, 0])).toBeCloseTo(0.5, 9);
		expect(faceClearance(square, [2, 0])).toBeCloseTo(-1, 9);
	});
});
