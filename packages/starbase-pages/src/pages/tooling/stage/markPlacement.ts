// Where the reference mark (the small arrow on the top face, pointing at corner 0) sits, and how big it is.
// Pure, no three.js: the 3D builder (scene/insertMesh.ts), the brazed tip (scene/tipMesh.ts) and the 2D drawing
// (outline2d.ts, in the entry chunk) all read the same numbers. Top-view coordinates, millimetres.

import type { InsertGeometry, InsertOutline } from '@d1/ui';

export const MARK_MARGIN_MM = 0.5; // clear of the face rim
const HOLE_MARGIN_MM = 0.4; // clear of the hole (or its countersink)
const TIP_RESERVE_MM = 1.8; // a tipped insert keeps at least this much brazed wedge between the mark and the nose
const TIP_STOP_GAP_MM = 0.3; // tipMesh.ts stops its pad this far short of the mark
const MIN_SIZE_MM = 0.5;
const STEP_MM = 0.1;

// The arrow in (along the bisector, across it) units of `size`: a tip ahead of the middle, a base behind it.
export const MARK_TIP = 0.6;
export const MARK_BASE = -0.4;
export const MARK_HALF_WIDTH = 0.45;

type Pt = [number, number];

// The radius of the top-face opening: the hole, or its countersink, as insertMesh.ts cuts it.
function openingRadius(geom: InsertGeometry): number {
	if (!geom.holeDiameterMm) return 0;
	const r = geom.icMm / 2;
	const rHole = Math.min(geom.holeDiameterMm / 2, r * 0.6);
	return geom.holeCountersunk ? Math.min(rHole * 1.5, r * 0.75) : rHole;
}

// How far inside the outline a point is (negative outside): the distance to the nearest side, signed.
export function faceClearance(points: ReadonlyArray<Pt>, p: Pt): number {
	let inside = false;
	let nearest = Infinity;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [ax, ay] = points[j];
		const [bx, by] = points[i];
		if ((ay > p[1]) !== (by > p[1]) && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) inside = !inside;
		const dx = bx - ax, dy = by - ay;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
		nearest = Math.min(nearest, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
	}
	return inside ? nearest : -nearest;
}

// The arrow's three corners for a size and a distance along corner 0's bisector (top-view x, y).
export function markVertices(bisectorDeg: number, size: number, d: number): [Pt, Pt, Pt] {
	const a = (bisectorDeg * Math.PI) / 180;
	const dir: Pt = [Math.cos(a), Math.sin(a)];
	const side: Pt = [-dir[1], dir[0]];
	const at = (along: number, across: number): Pt => [dir[0] * along + side[0] * across, dir[1] * along + side[1] * across];
	return [at(d + size * MARK_TIP, 0), at(d + size * MARK_BASE, -size * MARK_HALF_WIDTH), at(d + size * MARK_BASE, size * MARK_HALF_WIDTH)];
}

// Where the mark sits along corner 0's bisector (from the centre): its middle, and the end nearest the corner.
// It scales with the insert and sits as large as fits, clear of the hole, the rim and the corner; on a tipped
// insert it moves in toward the hole, to leave the corner to the tip pad (tipMesh.ts). For a milling insert
// (shape 'rect') the bisector runs through the corner's fillet centre, which is all the search needs.
export function markDistance(geom: InsertGeometry, outline: InsertOutline): { size: number; centre: number; end: number } {
	const c0 = outline.corners[0];
	const opening = openingRadius(geom);
	const tip = Math.hypot(c0.x, c0.y) + (geom.shape === 'R' ? 0 : geom.noseRadiusMm);
	const wanted = Math.min(3.2, Math.max(1.2, geom.icMm * 0.22));
	const tipped = geom.tipMaterial !== null;

	for (let size = wanted; size >= MIN_SIZE_MM; size *= 0.92) {
		const first = Math.max(opening > 0 ? opening + HOLE_MARGIN_MM : 0.5, 0.5) - size * MARK_BASE;
		let lo = -1;
		let hi = -1;
		for (let d = first; d <= tip; d += STEP_MM) {
			const fits = markVertices(c0.bisectorDeg, size, d).every((v) => faceClearance(outline.points, v) >= MARK_MARGIN_MM)
				&& (!tipped || d + size * MARK_TIP + TIP_STOP_GAP_MM <= tip - TIP_RESERVE_MM);
			if (!fits) continue;
			if (lo < 0) lo = d;
			hi = d;
		}
		if (lo >= 0) {
			const centre = tipped ? lo : (lo + hi) / 2;
			return { size, centre, end: centre + size * MARK_TIP };
		}
	}
	const size = MIN_SIZE_MM;
	const centre = Math.max(opening * 1.6, 0.5) + size * 0.4;
	return { size, centre, end: centre + size * MARK_TIP };
}
