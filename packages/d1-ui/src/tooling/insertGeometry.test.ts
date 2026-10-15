import { describe, expect, it } from 'vitest';
import { placeEdge } from './edgePlacement';
import { insertOutline, resolveInsertGeometry, type InsertTypeRow } from './insertGeometry';

const type = (iso: string | null, extra: Partial<InsertTypeRow> = {}): InsertTypeRow => ({ iso_designation: iso, ...extra });

// Signed area by the shoelace formula; negative = clockwise with y up.
function signedArea(points: Array<[number, number]>): number {
	let s = 0;
	for (let i = 0; i < points.length; i++) {
		const [x1, y1] = points[i];
		const [x2, y2] = points[(i + 1) % points.length];
		s += x1 * y2 - x2 * y1;
	}
	return s / 2;
}

function angleAt(p: [number, number], a: [number, number], b: [number, number]): number {
	const v1 = [a[0] - p[0], a[1] - p[1]];
	const v2 = [b[0] - p[0], b[1] - p[1]];
	const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
	return (Math.acos(cos) * 180) / Math.PI;
}

describe('resolveInsertGeometry', () => {
	it('resolves CNMG 12 04 08 from the designation', () => {
		const g = resolveInsertGeometry(type('CNMG 12 04 08-MF'));
		expect(g).toMatchObject({
			shape: 'C', recognised: true, includedAngleDeg: 80, cornerCount: 4, cuttingCorners: [0, 2],
			icMm: 12.7, thicknessMm: 4.76, noseRadiusMm: 0.8, clearanceDeg: 0, doubleSided: true,
			holeCountersunk: false, edgesPerFace: 2,
		});
		expect(g.holeDiameterMm).toBeCloseTo(5.16, 2);
	});

	it('resolves CCMT as single-sided with a countersunk hole', () => {
		const g = resolveInsertGeometry(type('CCMT 09 T3 04'));
		expect(g).toMatchObject({ shape: 'C', clearanceDeg: 7, doubleSided: false, holeCountersunk: true, edgesPerFace: 2 });
		expect(g.holeDiameterMm).toBeCloseTo(4.4, 1);
	});

	it.each([
		['TNMG160408', 'T', 60, 3, [0, 1, 2]],
		['SNMG120408', 'S', 90, 4, [0, 1, 2, 3]],
		['DCMT11T304', 'D', 55, 4, [0, 2]],
		['VCMT160404', 'V', 35, 4, [0, 2]],
		['WNMG080408', 'W', 80, 3, [0, 1, 2]],
	])('%s is shape %s, %i degrees, %i corners', (iso, shape, angle, corners, cutting) => {
		const g = resolveInsertGeometry(type(iso));
		expect(g.shape).toBe(shape);
		expect(g.includedAngleDeg).toBe(angle);
		expect(g.cornerCount).toBe(corners);
		expect(g.cuttingCorners).toEqual(cutting);
		expect(g.edgesPerFace).toBe(cutting.length);
	});

	it('uses the ISO rule for double-sided when edge_count is not set', () => {
		expect(resolveInsertGeometry(type('TNMG160408')).doubleSided).toBe(true);
		expect(resolveInsertGeometry(type('TCMT110204')).doubleSided).toBe(false);
	});

	it('lets edge_count decide double-sided: >= 2 x cutting corners', () => {
		expect(resolveInsertGeometry(type('CNMG120408', { edge_count: 2 })).doubleSided).toBe(false);
		expect(resolveInsertGeometry(type('CNMG120408', { edge_count: 4 })).doubleSided).toBe(true);
		expect(resolveInsertGeometry(type('CCMT09T304', { edge_count: 4 })).doubleSided).toBe(true);
		expect(resolveInsertGeometry(type('TNMG160408', { edge_count: 3 })).doubleSided).toBe(false);
	});

	it('lets edge_count cap the cutting corners: a one-edge CCGW is single-sided with only corner A', () => {
		const g = resolveInsertGeometry(type('CCGW 09T3 04', { edge_count: 1 }));
		expect(g).toMatchObject({ shape: 'C', cornerCount: 4, cuttingCorners: [0], edgesPerFace: 1, doubleSided: false });
		expect(placeEdge(g, 'A')).toEqual({ face: 'top', corner: 0 });
		expect(placeEdge(g, 'B')).toBeNull();
		expect(insertOutline(g).corners.map((c) => c.cuts)).toEqual([true, false, false, false]);
	});

	it('caps to the first edge_count corners, from A, and leaves a count at or above the corners alone', () => {
		expect(resolveInsertGeometry(type('TNMG160408', { edge_count: 2 })).cuttingCorners).toEqual([0, 1]);
		expect(resolveInsertGeometry(type('SNMG120408', { edge_count: 3 }))).toMatchObject({ cuttingCorners: [0, 1, 2], doubleSided: false });
		expect(resolveInsertGeometry(type('CNMG120408', { edge_count: 2 })).cuttingCorners).toEqual([0, 2]);
		expect(resolveInsertGeometry(type('CNMG120408', { edge_count: 3 })).cuttingCorners).toEqual([0, 2]);
		expect(resolveInsertGeometry(type('CNMG120408', { edge_count: 4 }))).toMatchObject({ cuttingCorners: [0, 2], doubleSided: true });
		expect(resolveInsertGeometry(type('RCMT1204M0', { edge_count: 6 })).cuttingCorners).toHaveLength(6);
	});

	describe('tipMaterial', () => {
		it('is null for a plain carbide insert', () => {
			expect(resolveInsertGeometry(type('CNMG120408-MF', { substrate: 'Carbide', type_code: 'CNMG120408-MF' })).tipMaterial).toBeNull();
			expect(resolveInsertGeometry(null).tipMaterial).toBeNull();
		});

		it('reads PCD and diamond from the substrate, the type code or the ISO suffix, in any case', () => {
			expect(resolveInsertGeometry(type('CCGW 09T3 04', { substrate: 'PCD' })).tipMaterial).toBe('pcd');
			expect(resolveInsertGeometry(type('CCGW 09T3 04', { substrate: 'Polycrystalline Diamond' })).tipMaterial).toBe('pcd');
			expect(resolveInsertGeometry(type('CCGW 09T3 04', { substrate: 'diamond' })).tipMaterial).toBe('pcd');
			expect(resolveInsertGeometry(type('CCGW 09T3 04', { type_code: 'CCGW09T304-PCD' })).tipMaterial).toBe('pcd');
			expect(resolveInsertGeometry(type('CCGW09T304-pcd')).tipMaterial).toBe('pcd');
			expect(resolveInsertGeometry(type('CCGW 09T3 04-PCD')).recognised).toBe(true); // the suffix does not break the parse
		});

		it('reads PCBN and CBN as cbn', () => {
			expect(resolveInsertGeometry(type('CNGA 12 04 08', { substrate: 'PCBN' })).tipMaterial).toBe('cbn');
			expect(resolveInsertGeometry(type('CNGA120408', { type_code: 'CNGA120408 CBN' })).tipMaterial).toBe('cbn');
			expect(resolveInsertGeometry(type('CNGA120408-PCBN')).tipMaterial).toBe('cbn');
			expect(resolveInsertGeometry(type('CNGA120408', { substrate: 'cBN' })).tipMaterial).toBe('cbn');
		});

		it('does not read the ISO material class (a group letter like P, M, K, N) and does not match inside a word', () => {
			expect(resolveInsertGeometry(type('CNMG120408', { material_class: 'N' })).tipMaterial).toBeNull();
			expect(resolveInsertGeometry(type('CNMG120408', { material_class: 'PCD' })).tipMaterial).toBeNull();
			expect(resolveInsertGeometry(type('CNMG120408', { substrate: 'Scbnx' })).tipMaterial).toBeNull();
		});
	});

	it('lets non-null override columns win', () => {
		const g = resolveInsertGeometry(
			type('CNMG120408', { nose_radius_mm: 1.2, included_angle_deg: 82, fixing_hole_diameter_mm: 6, cutting_edge_length_mm: 13 }),
		);
		expect(g.noseRadiusMm).toBe(1.2);
		expect(g.includedAngleDeg).toBe(82);
		expect(g.holeDiameterMm).toBe(6);
		expect(g.icMm).toBeCloseTo(13 * Math.sin((82 * Math.PI) / 180), 3);
	});

	it('accepts numeric strings from the API and keeps a zero nose radius', () => {
		const g = resolveInsertGeometry(type('CNMG120408', { nose_radius_mm: '0.000', fixing_hole_diameter_mm: '5.500' }));
		expect(g.noseRadiusMm).toBe(0);
		expect(g.holeDiameterMm).toBe(5.5);
	});

	it('ignores null and nonsense overrides', () => {
		const g = resolveInsertGeometry(type('CNMG120408', { nose_radius_mm: null, included_angle_deg: 0, fixing_hole_diameter_mm: 'x' }));
		expect(g.noseRadiusMm).toBe(0.8);
		expect(g.includedAngleDeg).toBe(80);
	});

	it('ignores an included angle far from the shape letter (live CNMG row: 0.010)', () => {
		const g = resolveInsertGeometry({ type_code: 'CNMG 12 04 08-SM H13A', iso_designation: 'CNMG 12 04 08', edge_count: 4, included_angle_deg: '0.010', cutting_edge_length_mm: '8.500' });
		expect(g.includedAngleDeg).toBe(80);
		expect(g.icMm).toBeCloseTo(8.5 * Math.sin((80 * Math.PI) / 180), 3);
	});

	it('has no hole for a type letter without one, unless the row gives a diameter', () => {
		expect(resolveInsertGeometry(type('CNMN120408')).holeDiameterMm).toBeNull();
		expect(resolveInsertGeometry(type('CNMN120408', { fixing_hole_diameter_mm: 5 })).holeDiameterMm).toBe(5);
	});

	it('draws a round insert with edge letters from edge_count', () => {
		const g = resolveInsertGeometry(type('RCMT1204M0'));
		expect(g).toMatchObject({ shape: 'R', recognised: true, includedAngleDeg: 360, icMm: 12, cornerCount: 4, cuttingCorners: [0, 1, 2, 3] });
		const two = resolveInsertGeometry(type('RNMG120400', { edge_count: 8 }));
		expect(two).toMatchObject({ cornerCount: 4, edgesPerFace: 4, doubleSided: true });
		expect(resolveInsertGeometry(type('RCMT1204M0', { edge_count: 6 })).cornerCount).toBe(6);
	});

	it('falls back to a regular polygon from edge_count, not recognised', () => {
		const six = resolveInsertGeometry(type('garbage', { edge_count: 6 }));
		expect(six).toMatchObject({
			shape: 'polygon', recognised: false, cornerCount: 6, cuttingCorners: [0, 1, 2, 3, 4, 5], includedAngleDeg: 120,
			doubleSided: false, icMm: 12.7, thicknessMm: 4.76, noseRadiusMm: 0.8, holeDiameterMm: null,
		});
		expect(resolveInsertGeometry(type(null, { edge_count: 3 })).cornerCount).toBe(3);
	});

	it('falls back to a square with no type, no edge_count or fewer than 3 edges', () => {
		for (const t of [null, type(null), type('nope', { edge_count: 2 }), type('nope', { edge_count: null })]) {
			const g = resolveInsertGeometry(t);
			expect(g).toMatchObject({ shape: 'polygon', recognised: false, cornerCount: 4, includedAngleDeg: 90, doubleSided: false });
		}
	});

	it('still applies overrides to the fallback polygon', () => {
		const g = resolveInsertGeometry(type(null, { edge_count: 3, nose_radius_mm: 0.4, cutting_edge_length_mm: 10 }));
		expect(g.noseRadiusMm).toBe(0.4);
		expect(g.icMm).toBeCloseTo(10 / Math.sqrt(3), 3);
	});
});

describe('insertOutline', () => {
	const sharp = (iso: string) => resolveInsertGeometry(type(iso, { nose_radius_mm: 0 }));

	it.each([
		['CNMG120408', 80], ['DCMT11T304', 55], ['VCMT160404', 35], ['TNMG160408', 60], ['SNMG120408', 90], ['WNMG080408', 80],
	])('%s: the included angle at corner 0 is %i degrees', (iso, deg) => {
		const g = sharp(iso);
		const o = insertOutline(g);
		expect(o.corners[0].angleDeg).toBeCloseTo(deg, 6);
		// with a sharp nose the outline points are the vertices: corner 0 is the first point
		const n = o.points.length;
		expect(angleAt(o.points[0], o.points[1], o.points[n - 1])).toBeCloseTo(deg, 6);
	});

	it('is clockwise with y up (negative signed area)', () => {
		for (const iso of ['CNMG120408', 'TNMG160408', 'SNMG120408', 'WNMG080408', 'RCMT1204M0', 'VCMT160404']) {
			expect(signedArea(insertOutline(resolveInsertGeometry(type(iso))).points), iso).toBeLessThan(0);
		}
		expect(signedArea(insertOutline(resolveInsertGeometry(type(null, { edge_count: 5 }))).points)).toBeLessThan(0);
	});

	it('has cornerCount corners with the cutting flags and corner 0 at the reference corner', () => {
		const g = resolveInsertGeometry(type('CNMG120408'));
		const o = insertOutline(g);
		expect(o.corners).toHaveLength(g.cornerCount);
		expect(o.corners.map((c) => c.index)).toEqual([0, 1, 2, 3]);
		expect(o.corners.map((c) => c.cuts)).toEqual([true, false, true, false]);
		expect(o.corners.map((c) => c.angleDeg.toFixed(0))).toEqual(['80', '100', '80', '100']);
		expect(o.corners[0].bisectorDeg).toBeCloseTo(90, 6);
		expect(o.corners[1].bisectorDeg).toBeCloseTo(0, 6);
		expect(o.corners[2].bisectorDeg).toBeCloseTo(270, 6);
		expect(o.corners[3].bisectorDeg).toBeCloseTo(180, 6);
		// corner 0 is the topmost
		expect(o.corners[0].y).toBeGreaterThan(o.corners[1].y);
	});

	it('draws a W with three corners, the truncated ones between them being plain points', () => {
		const g = resolveInsertGeometry(type('WNMG080408'));
		const o = insertOutline(g);
		expect(o.corners).toHaveLength(3);
		expect(o.corners.every((c) => c.cuts && Math.abs(c.angleDeg - 80) < 1e-9)).toBe(true);
		expect(o.corners.map((c) => Math.round(c.bisectorDeg))).toEqual([90, 330, 210]);
	});

	it('puts the fillet centre inside the sharp corner and the fillet points at the nose radius from it', () => {
		const g = resolveInsertGeometry(type('CNMG120408'));
		const o = insertOutline(g);
		const c0 = o.corners[0];
		const near = o.points.filter((p) => Math.hypot(p[0] - c0.x, p[1] - c0.y) < 0.8 + 1e-9);
		expect(near.length).toBeGreaterThanOrEqual(10);
		for (const p of near) expect(Math.hypot(p[0] - c0.x, p[1] - c0.y)).toBeCloseTo(0.8, 6);
		const sharpTop = insertOutline(sharp('CNMG120408')).corners[0];
		expect(c0.y).toBeLessThan(sharpTop.y);
	});

	it('samples every fillet at 10 degrees or finer, and the outline is closed without repeating', () => {
		const o = insertOutline(resolveInsertGeometry(type('CNMG120408')));
		// 100 degree arcs -> 10 segments (11 points), 80 degree arcs -> 8 segments (9 points)
		expect(o.points).toHaveLength(2 * 11 + 2 * 9);
		const first = o.points[0];
		const last = o.points[o.points.length - 1];
		expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeGreaterThan(1e-6);
	});

	it('keeps the inscribed circle at IC: every side of a sharp CNMG is IC/2 from the centre', () => {
		const o = insertOutline(sharp('CNMG120408'));
		const p = o.points;
		for (let i = 0; i < p.length; i++) {
			const [x1, y1] = p[i];
			const [x2, y2] = p[(i + 1) % p.length];
			const dist = Math.abs(x1 * y2 - x2 * y1) / Math.hypot(x2 - x1, y2 - y1);
			expect(dist).toBeCloseTo(6.35, 6);
		}
	});

	it('draws a square as flat sides with IC as its width', () => {
		const o = insertOutline(sharp('SNMG120408'));
		const xs = o.points.map((p) => p[0]);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12.7, 6);
	});

	it('clamps a huge nose radius so the fillets do not overlap', () => {
		const o = insertOutline(resolveInsertGeometry(type('CNMG120408', { nose_radius_mm: 50 })));
		expect(o.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
		expect(Math.max(...o.points.map((p) => Math.hypot(p[0], p[1])))).toBeLessThan(13);
	});

	it('draws a round insert as a circle with evenly spaced corners', () => {
		const g = resolveInsertGeometry(type('RCMT1204M0'));
		const o = insertOutline(g);
		expect(o.points.length).toBeGreaterThanOrEqual(36);
		for (const p of o.points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(6, 6);
		expect(o.corners.map((c) => Math.round(c.bisectorDeg))).toEqual([90, 0, 270, 180]);
		expect(o.corners.every((c) => c.cuts)).toBe(true);
		expect(Math.hypot(o.corners[0].x, o.corners[0].y)).toBeCloseTo(6, 6);
	});

	it('draws the fallback polygon with n equal corners', () => {
		const o = insertOutline(resolveInsertGeometry(type('?', { edge_count: 5, nose_radius_mm: 0 })));
		expect(o.corners).toHaveLength(5);
		expect(o.corners[0].angleDeg).toBeCloseTo(108, 6);
		expect(o.points).toHaveLength(5);
	});
});

describe('designation from type_code', () => {
	it.each([
		['CNMG 12 04 08-SM H13A', 'C'], ['DNMG150604-MF1 890 (A41)', 'D'], ['TCMT 16 T3 08-KM H13A', 'T'], ['RCMT 08 03 MP-H7 S205', 'R'],
	])('reads the shape of %s when iso_designation is empty', (code, shape) => {
		expect(resolveInsertGeometry({ iso_designation: null, type_code: code, edge_count: 4 })).toMatchObject({ shape, recognised: true });
	});

	it('draws a rhombus, not a square, for a CNMG with only a type_code', () => {
		const g = resolveInsertGeometry({ iso_designation: null, type_code: 'CNMG 12 04 08-SM H13A', edge_count: 4 });
		expect(g.shape).toBe('C');
		expect(insertOutline(g).corners.map((c) => Math.round(c.angleDeg))).toEqual([80, 100, 80, 100]);
	});
});

describe('milling inserts (R390)', () => {
	const r390 = { iso_designation: null, type_code: 'R390-11 T3 08M-MM S30T', nose_radius_mm: 0.8, fixing_hole_diameter_mm: 2.8 };

	it('resolves R390-11 as an 11.45 x 6.8 rectangle with two cutting corners', () => {
		const g = resolveInsertGeometry(r390);
		expect(g).toMatchObject({
			shape: 'rect', recognised: true, lengthMm: 11.45, icMm: 6.8, thicknessMm: 3.59, noseRadiusMm: 0.8,
			cuttingCorners: [0, 2], edgesPerFace: 2, doubleSided: false, holeCountersunk: true,
		});
	});

	it('letters A and B on the opposite corners of the one face', () => {
		const g = resolveInsertGeometry(r390);
		expect(placeEdge(g, 'A')).toEqual({ face: 'top', corner: 0 });
		expect(placeEdge(g, 'B')).toEqual({ face: 'top', corner: 2 });
		expect(placeEdge(g, 'C')).toBeNull();
	});

	it('draws a clockwise rectangle of the right size', () => {
		const o = insertOutline(resolveInsertGeometry(r390));
		const xs = o.points.map((p) => p[0]);
		const ys = o.points.map((p) => p[1]);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(11.45, 6);
		expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6.8, 6);
		expect(signedArea(o.points)).toBeLessThan(0);
		expect(o.corners.map((c) => c.angleDeg)).toEqual([90, 90, 90, 90]);
	});

	it('leaves an unknown R390 size as a generic polygon', () => {
		expect(resolveInsertGeometry({ type_code: 'R390-18 T3 08M-MM', edge_count: 4 })).toMatchObject({ shape: 'polygon', recognised: false });
	});
});

describe('rect corner bearing', () => {
	it('points each corner bearing at its fillet centre, so a step out from the middle lands on the corner', () => {
		const o = insertOutline(resolveInsertGeometry({ type_code: 'R390-11 T3 08M-MM S30T' }));
		for (const c of o.corners) {
			const a = (c.bisectorDeg * Math.PI) / 180;
			expect(Math.hypot(c.x, c.y) * Math.sin(a)).toBeCloseTo(c.y, 9);
			expect(Math.hypot(c.x, c.y) * Math.cos(a)).toBeCloseTo(c.x, 9);
		}
	});
});
