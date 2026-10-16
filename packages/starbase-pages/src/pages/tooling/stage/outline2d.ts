// The insert outline as an SVG path, for the 2D view. Pure, no three.js: this file is in the entry chunk.
// The top view has y up; SVG has y down, so y is flipped. Units are millimetres.

import type { EdgePlacement, InsertGeometry, InsertOutline } from '@d1/ui';
import { markDistance, markVertices } from './markPlacement';

export interface Outline2D {
	path: string;
	viewBox: string;
	hole: { r: number } | null;
	mark: string; // the reference triangle at corner 0
	nose: (corner: number) => { x: number; y: number }; // where a letter bubble sits, outside the corner
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

// `face`: the underside is drawn as it looks turned over like a page, mirrored left to right, so a corner keeps its place from
// the top view to the underside view (a mirrored drawing has no reference mark: it is on the top face only).
export function outline2d(geom: InsertGeometry, outline: InsertOutline, face: EdgePlacement['face'] = 'top'): Outline2D {
	const sx = face === 'bottom' ? -1 : 1;
	const pts = outline.points;
	const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f(sx * x)} ${f(-y)}`).join(' ') + ' Z';
	const reach = Math.max(geom.icMm / 2, ...outline.corners.map((c) => Math.hypot(c.x, c.y) + geom.noseRadiusMm));
	const pad = 5;
	const half = reach + pad;
	const viewBox = `${f(-half)} ${f(-half)} ${f(2 * half)} ${f(2 * half)}`;

	const nose = (corner: number) => {
		const c = outline.corners[corner];
		if (!c) return { x: 0, y: 0 };
		const a = (c.bisectorDeg * Math.PI) / 180;
		const d = (geom.shape === 'R' ? 0 : geom.noseRadiusMm) + 2.3;
		return { x: sx * (c.x + Math.cos(a) * d), y: -(c.y + Math.sin(a) * d) };
	};

	const c0 = outline.corners[0];
	let mark = '';
	const placed = c0 ? markDistance(geom, outline) : null; // the same size and place as the 3D mark (markPlacement.ts)
	if (c0 && placed && face === 'top') {
		const { size, centre } = placed;
		const p = ([x, y]: [number, number]) => `${f(x)} ${f(-y)}`;
		const [tip, left, right] = markVertices(c0.bisectorDeg, size, centre);
		mark = `M${p(tip)} L${p(left)} L${p(right)} Z`;
	}
	return { path, viewBox, hole: geom.holeDiameterMm ? { r: geom.holeDiameterMm / 2 } : null, mark, nose };
}

// The faces a view shows, in order: the top, then the underside of a double-sided insert.
export function faces(geom: InsertGeometry): Array<EdgePlacement['face']> {
	return geom.doubleSided ? ['top', 'bottom'] : ['top'];
}
