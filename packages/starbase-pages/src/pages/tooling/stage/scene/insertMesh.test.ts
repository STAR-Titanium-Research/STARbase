import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3, type BufferGeometry } from 'three';
import { buildToolingModel, type EdgeRow, type InsertRow } from '@d1/ui';
import {
	bottomScale, buildInsertGeometry, buildReferenceMark, createEdgeSegments, edgeAnchor, edgePath, edgeRun,
	EdgeGeometryCache, sweepTube, wallScale,
} from './insertMesh';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-1' };
const model = (iso: string, extra: Record<string, unknown> = {}, edgeCount = 8) => {
	const inserts: InsertRow[] = [{ insert_id: 'i1', insert_code: 'X-1', insert_number: 1, is_depleted: false }];
	const edges: EdgeRow[] = 'ABCDEFGH'.slice(0, edgeCount).split('').map((l) => ({
		edge_id: `e${l}`, edge_code: `X-1${l}`, insert_id: 'i1', edge_identifier: l, is_used: false,
	}));
	return buildToolingModel(box, { iso_designation: iso, ...extra }, inserts, edges);
};
const cnmg = model('CNMG 12 04 08-MF');
const ccmt = model('CCMT 09 T3 04', {}, 4);

function bounds(g: BufferGeometry) {
	g.computeBoundingBox();
	const b = g.boundingBox!;
	return { w: b.max.x - b.min.x, h: b.max.y - b.min.y, d: b.max.z - b.min.z, b };
}

// Winding agrees with the stored normals on every triangle: the mesh is not inside out.
function windingAgrees(g: BufferGeometry): number {
	const p = g.getAttribute('position');
	const n = g.getAttribute('normal');
	let bad = 0;
	const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
	for (let i = 0; i < p.count; i += 3) {
		a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
		const face = b.sub(a).cross(c.sub(a));
		const normal = new Vector3(n.getX(i), n.getY(i), n.getZ(i));
		if (face.dot(normal) < 0) bad++;
	}
	return bad;
}

describe('buildInsertGeometry', () => {
	it('is a closed set of triangles with the thickness of the insert', () => {
		const g = buildInsertGeometry(cnmg.geometry, cnmg.outline);
		expect(g.getAttribute('position').count).toBeGreaterThan(200);
		expect(g.getAttribute('position').count % 3).toBe(0);
		expect(bounds(g).h).toBeCloseTo(4.76, 3);
	});

	it('spans the inscribed circle on a square, in x and z', () => {
		const m = model('SNMG 12 04 08');
		const b = bounds(buildInsertGeometry(m.geometry, m.outline));
		expect(b.w).toBeCloseTo(12.7, 1);
		expect(b.d).toBeCloseTo(12.7, 1);
		expect(b.h).toBeCloseTo(4.76, 3);
	});

	it('puts the reference corner of a rhombus toward -z, and its tip beyond the inscribed circle', () => {
		const b = bounds(buildInsertGeometry(cnmg.geometry, cnmg.outline)).b;
		expect(b.min.z).toBeLessThan(-8.5);
		expect(b.max.z).toBeGreaterThan(8.5);
		expect(b.max.x - b.min.x).toBeLessThan(b.max.z - b.min.z); // the long diagonal runs through corners 0 and 2
	});

	it('faces outward everywhere (winding agrees with the normals), with a hole', () => {
		expect(windingAgrees(buildInsertGeometry(cnmg.geometry, cnmg.outline))).toBe(0);
		expect(windingAgrees(buildInsertGeometry(ccmt.geometry, ccmt.outline))).toBe(0);
	});

	it('leaves the fixing hole open: no top-face triangle covers the centre', () => {
		const g = buildInsertGeometry(cnmg.geometry, cnmg.outline);
		const p = g.getAttribute('position');
		const top = cnmg.geometry.thicknessMm / 2;
		for (let i = 0; i < p.count; i += 3) {
			const flat = [0, 1, 2].every((k) => Math.abs(p.getY(i + k) - top) < 1e-6);
			if (!flat) continue;
			const cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
			const cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
			expect(Math.hypot(cx, cz)).toBeGreaterThan(2.4);
		}
	});

	it('has more triangles with a hole than without', () => {
		const withHole = buildInsertGeometry(cnmg.geometry, cnmg.outline).getAttribute('position').count;
		const none = model('CNMG 12 04 08', { fixing_hole_diameter_mm: 0 });
		const noHole = { ...none.geometry, holeDiameterMm: null };
		expect(buildInsertGeometry(noHole, none.outline).getAttribute('position').count).toBeLessThan(withHole);
	});

	it('adds a countersink cone to countersunk holes', () => {
		const sunk = buildInsertGeometry(ccmt.geometry, ccmt.outline).getAttribute('position').count;
		const straight = buildInsertGeometry({ ...ccmt.geometry, holeCountersunk: false }, ccmt.outline).getAttribute('position').count;
		expect(sunk).toBeGreaterThan(straight);
	});

	it('tapers a positive-clearance insert: the underside is smaller than the top', () => {
		expect(bottomScale(cnmg.geometry)).toBe(1); // N: no clearance
		const k = bottomScale(ccmt.geometry);
		expect(k).toBeLessThan(1);
		expect(k).toBeCloseTo(1 - (2 * 3.97 * Math.tan((7 * Math.PI) / 180)) / 9.525, 3);
		expect(wallScale(ccmt.geometry, ccmt.geometry.thicknessMm / 2)).toBeCloseTo(1, 6);
		expect(wallScale(ccmt.geometry, -ccmt.geometry.thicknessMm / 2)).toBeCloseTo(k, 6);

		const g = buildInsertGeometry(ccmt.geometry, ccmt.outline);
		const p = g.getAttribute('position');
		let topReach = 0;
		let bottomReach = 0;
		for (let i = 0; i < p.count; i++) {
			const r = Math.hypot(p.getX(i), p.getZ(i));
			if (p.getY(i) > 0) topReach = Math.max(topReach, r);
			else bottomReach = Math.max(bottomReach, r);
		}
		expect(bottomReach).toBeLessThan(topReach);
	});

	it('builds a fallback polygon and a round insert too', () => {
		const odd = model('???', {}, 5);
		expect(buildInsertGeometry(odd.geometry, odd.outline).getAttribute('position').count).toBeGreaterThan(100);
		const round = model('RCMT1204M0', {}, 4);
		expect(bounds(buildInsertGeometry(round.geometry, round.outline)).w).toBeCloseTo(12.0, 0);
	});
});

describe('buildReferenceMark', () => {
	it('is a small flat mark on the top face, toward corner 0', () => {
		const g = buildReferenceMark(cnmg.geometry, cnmg.outline);
		const b = bounds(g);
		expect(b.h).toBeLessThan(0.2);
		expect(b.b.min.y).toBeGreaterThan(cnmg.geometry.thicknessMm / 2 - 0.1);
		const centre = new Vector3();
		g.boundingBox!.getCenter(centre);
		expect(centre.z).toBeLessThan(-3); // corner 0 points to -z
		expect(Math.abs(centre.x)).toBeLessThan(0.5);
	});
});

describe('edge segments', () => {
	it('runs along the nose arc and a quarter of each side', () => {
		const run = edgeRun(cnmg.geometry, cnmg.outline, 0);
		// 100 degrees of exterior angle in <= 10 degree steps is 11 arc points, plus the two side ends.
		expect(run.length).toBe(13);
		const c = cnmg.outline.corners[0];
		const mid = run[Math.floor(run.length / 2)];
		expect(Math.hypot(mid[0] - c.x, mid[1] - c.y)).toBeCloseTo(0.8, 3);
		// the side ends sit on the straight sides, away from the arc
		expect(Math.hypot(run[0][0] - c.x, run[0][1] - c.y)).toBeGreaterThan(0.8);
	});

	it('works for sharp, round and square corners', () => {
		const sharp = model('CNMG 12 04 00');
		expect(edgeRun(sharp.geometry, sharp.outline, 0).length).toBe(3);
		const round = model('RCMT1204M0', {}, 4);
		expect(edgeRun(round.geometry, round.outline, 1).length).toBeGreaterThan(2);
		const sq = model('SNMG 12 04 08');
		for (let c = 0; c < 4; c++) expect(edgeRun(sq.geometry, sq.outline, c).length).toBeGreaterThan(5);
	});

	it('puts a top edge on the upper rim and a bottom edge on the lower rim', () => {
		const top = edgePath(cnmg.geometry, cnmg.outline, { face: 'top', corner: 0 });
		const bottom = edgePath(cnmg.geometry, cnmg.outline, { face: 'bottom', corner: 0 });
		expect(top.every((p) => p[1] > 2)).toBe(true);
		expect(bottom.every((p) => p[1] < -2)).toBe(true);
		expect(top[0][2]).toBeLessThan(0); // corner 0 is toward -z
	});

	it('builds one segment per placed edge, tagged with the ids', () => {
		const cache = new EdgeGeometryCache(cnmg.geometry, cnmg.outline);
		const meshes = createEdgeSegments(cnmg.inserts[0], cache, new MeshBasicMaterial());
		expect(meshes).toHaveLength(4); // CNMG: A to D; E to H are beyond the shape, so no segment
		expect(meshes.map((m) => m.userData)).toEqual(
			['A', 'B', 'C', 'D'].map((l) => ({ kind: 'edge', insertId: 'i1', edgeId: `e${l}` })),
		);
		expect(cache.size).toBe(4);
		createEdgeSegments(cnmg.inserts[0], cache, new MeshBasicMaterial());
		expect(cache.size).toBe(4); // geometries are shared
		cache.dispose();
		expect(cache.size).toBe(0);
	});

	it('gives CCMT two segments for A and B, and none for edges it has no place for', () => {
		const withJunk = buildToolingModel(box, { iso_designation: 'CCMT 09 T3 04' },
			[{ insert_id: 'i1', insert_code: 'X-1', insert_number: 1, is_depleted: false }],
			['A', 'B', 'C', 'zz'].map((l, i) => ({ edge_id: `e${i}`, edge_code: `c${i}`, insert_id: 'i1', edge_identifier: l, is_used: false })));
		const cache = new EdgeGeometryCache(withJunk.geometry, withJunk.outline);
		expect(createEdgeSegments(withJunk.inserts[0], cache, new MeshBasicMaterial())).toHaveLength(2);
	});

	it('sweeps a tube: sides x points vertices, indexed, around the path', () => {
		const g = sweepTube([[0, 0, 0], [1, 0, 0], [2, 0, 0]], 0.2, 8);
		expect(g.getAttribute('position').count).toBe(24);
		expect(g.getIndex()!.count).toBe(2 * 8 * 6);
		const b = bounds(g);
		expect(b.h).toBeCloseTo(0.4, 3);
		expect(b.d).toBeCloseTo(0.4, 3);
	});

	it('anchors a letter pill outside its corner, at the right face', () => {
		const top = edgeAnchor(cnmg.geometry, cnmg.outline, { face: 'top', corner: 0 });
		const bottom = edgeAnchor(cnmg.geometry, cnmg.outline, { face: 'bottom', corner: 0 });
		expect(top[1]).toBeCloseTo(2.38, 2);
		expect(bottom[1]).toBeCloseTo(-2.38, 2);
		expect(top[2]).toBeLessThan(-9.4); // beyond the nose tip at -z
		expect(top[0]).toBeCloseTo(bottom[0], 6); // C is directly under A
	});
});
