// The brazed tip of a PCD or PCBN insert: one thin wedge per cutting corner, lying on the top face (and on the
// underside of a double-sided insert), covering the nose and about 3 mm of each side beside it. Pure builder
// (no renderer), in the insert's world-oriented local space, like insertMesh.ts.

import { BufferGeometry, ExtrudeGeometry, Shape, Vector2 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { InsertGeometry, InsertOutline } from '@d1/ui';
import { arcRun, BEVEL_MM, markDistance } from './insertMesh';

export const TIP_SIDE_MM = 3; // how far the pad runs along each side from the nose arc
export const TIP_DEPTH_MM = 3.4; // how far the pad reaches in from the nose tip, at most
const MIN_TIP_DEPTH_MM = 1.2;
const PAD_THICKNESS_MM = 0.05; // a hair proud of the face, so it never z-fights with it

type Pt = [number, number];

const toward = (from: Pt, to: Pt, mm: number): Pt => {
	const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
	if (len < 1e-9) return from;
	const t = Math.min(0.5, mm / len); // never past the middle of a short side
	return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
};

// The pad of one corner in top-view coordinates: the outline run (pulled in by the bevel) and an inner point
// on the bisector, so the pad is a kite, the shape of a brazed wedge.
function padOutline(geom: InsertGeometry, outline: InsertOutline, corner: number): Pt[] | null {
	const arc = arcRun(geom, outline, corner);
	const c = outline.corners[corner];
	if (!arc || !c) return null;
	const r = geom.icMm / 2;
	const inset = (r - Math.min(BEVEL_MM, geom.thicknessMm / 4, r / 8)) / r; // the flat face, as insertMesh draws it
	const run: Pt[] = [toward(arc.run[0], arc.before, TIP_SIDE_MM), ...arc.run, toward(arc.run[arc.run.length - 1], arc.after, TIP_SIDE_MM)];
	const tip = Math.hypot(c.x, c.y) + (geom.shape === 'R' ? 0 : geom.noseRadiusMm);
	const a = (c.bisectorDeg * Math.PI) / 180;
	// Stop short of the reference mark (which sits on corner 0's bisector) and always keep a visible wedge.
	const stop = corner === 0 ? markDistance(geom, outline).end + 0.3 : 0;
	const depth = Math.max(MIN_TIP_DEPTH_MM, Math.min(TIP_DEPTH_MM, tip - stop));
	const inner = (tip - depth) * inset;
	return [...run.map(([x, y]): Pt => [x * inset, y * inset]), [Math.cos(a) * inner, Math.sin(a) * inner]];
}

function padGeometry(points: Pt[], y: number): BufferGeometry {
	const shape = new Shape(points.map(([x, z]) => new Vector2(x, z)));
	const g = new ExtrudeGeometry(shape, { depth: PAD_THICKNESS_MM, bevelEnabled: false });
	g.rotateX(-Math.PI / 2); // the top view's y becomes -z, the extrusion points up
	g.translate(0, y, 0);
	return g;
}

// All pads of one insert as one geometry, or null when the insert is not tipped.
export function buildTipGeometry(geom: InsertGeometry, outline: InsertOutline): BufferGeometry | null {
	if (!geom.tipMaterial) return null;
	const top = geom.thicknessMm / 2;
	const parts: BufferGeometry[] = [];
	for (const corner of geom.cuttingCorners) {
		const pad = padOutline(geom, outline, corner);
		if (!pad) continue;
		parts.push(padGeometry(pad, top - 0.01));
		if (geom.doubleSided) parts.push(padGeometry(pad, -top - PAD_THICKNESS_MM + 0.01));
	}
	if (parts.length === 0) return null;
	const merged = mergeGeometries(parts, false);
	for (const p of parts) p.dispose();
	return merged;
}
