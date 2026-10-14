// The insert outline as an SVG path, for the 2D view. Pure, no three.js: this file is in the entry chunk.
// The top view has y up; SVG has y down, so y is flipped. Units are millimetres.

import type { EdgePlacement, InsertGeometry, InsertOutline } from '@d1/ui';

export interface Outline2D {
	path: string;
	viewBox: string;
	hole: { r: number } | null;
	mark: string; // the reference triangle at corner 0
	nose: (corner: number) => { x: number; y: number }; // where a letter bubble sits, outside the corner
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

export function outline2d(geom: InsertGeometry, outline: InsertOutline): Outline2D {
	const pts = outline.points;
	const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f(x)} ${f(-y)}`).join(' ') + ' Z';
	const reach = Math.max(geom.icMm / 2, ...outline.corners.map((c) => Math.hypot(c.x, c.y) + geom.noseRadiusMm));
	const pad = 3.6;
	const half = reach + pad;
	const viewBox = `${f(-half)} ${f(-half)} ${f(2 * half)} ${f(2 * half)}`;

	const nose = (corner: number) => {
		const c = outline.corners[corner];
		if (!c) return { x: 0, y: 0 };
		const a = (c.bisectorDeg * Math.PI) / 180;
		const d = (geom.shape === 'R' ? 0 : geom.noseRadiusMm) + 2.3;
		return { x: c.x + Math.cos(a) * d, y: -(c.y + Math.sin(a) * d) };
	};

	const c0 = outline.corners[0];
	let mark = '';
	if (c0) {
		const a = (c0.bisectorDeg * Math.PI) / 180;
		const dir: [number, number] = [Math.cos(a), Math.sin(a)];
		const side: [number, number] = [-dir[1], dir[0]];
		const holeR = geom.holeDiameterMm ? geom.holeDiameterMm / 2 : 0;
		const d = Math.max((holeR * 1.5 + Math.hypot(c0.x, c0.y) + geom.noseRadiusMm) / 2, holeR * 1.6);
		const p = (along: number, across: number) =>
			`${f(dir[0] * along + side[0] * across)} ${f(-(dir[1] * along + side[1] * across))}`;
		mark = `M${p(d + 0.6, 0)} L${p(d - 0.4, -0.45)} L${p(d - 0.4, 0.45)} Z`;
	}
	return { path, viewBox, hole: geom.holeDiameterMm ? { r: geom.holeDiameterMm / 2 } : null, mark, nose };
}

// The faces a view shows, in order: the top, then the underside of a double-sided insert.
export function faces(geom: InsertGeometry): Array<EdgePlacement['face']> {
	return geom.doubleSided ? ['top', 'bottom'] : ['top'];
}
