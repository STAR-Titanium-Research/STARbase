// The cutting insert as three.js geometry. Pure builders: no renderer, so they run (and are tested) in Node.
//
// Insert-local space is world-oriented: y is up, the insert's mid-thickness is y = 0, and the top view's
// (x, y) outline maps to world (x, -y), so the reference corner (corner 0) points to -z, "up" on screen
// for the default camera, and the letters run clockwise seen from above. Millimetres.

import {
	BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape, ShapeUtils, Vector2,
	type Material, Mesh,
} from 'three';
import type { EdgePlacement, InsertGeometry, InsertOutline, ToolingInsert } from '@d1/ui';
import { markDistance, markVertices } from '../markPlacement';

export const BEVEL_MM = 0.15;
export const EDGE_TUBE_RADIUS_MM = 0.22;
// Fraction of each straight side that the edge segment runs along, next to the nose arc.
export const EDGE_SIDE_FRACTION = 0.25;
const HOLE_SEGMENTS = 40;
const TUBE_SIDES = 8;
const HARD_CORNER_DEG = 35;

type V3 = [number, number, number];
type Pt = [number, number];

// --- tapered body ------------------------------------------------------------------------------------

// Sides lean in by `t * tan(clearance)` over the thickness: the bottom ring is scaled by this (1 = straight).
export function bottomScale(geom: InsertGeometry): number {
	if (geom.doubleSided || geom.clearanceDeg <= 0) return 1;
	const k = 1 - (2 * geom.thicknessMm * Math.tan((geom.clearanceDeg * Math.PI) / 180)) / geom.icMm;
	return Math.max(0.5, k);
}

// Scale of the side wall at height y (the wall is a straight taper from the top ring to the bottom ring).
export function wallScale(geom: InsertGeometry, y: number): number {
	const t = geom.thicknessMm;
	return 1 - ((t / 2 - y) / t) * (1 - bottomScale(geom));
}

class MeshBuilder {
	readonly position: number[] = [];
	readonly normal: number[] = [];

	// One triangle; the winding is fixed to agree with the normals so callers need not care.
	tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3): void {
		const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
		const dot = fx * (na[0] + nb[0] + nc[0]) + fy * (na[1] + nb[1] + nc[1]) + fz * (na[2] + nb[2] + nc[2]);
		if (dot < 0) { [b, c] = [c, b]; [nb, nc] = [nc, nb]; }
		this.position.push(...a, ...b, ...c);
		this.normal.push(...na, ...nb, ...nc);
	}

	toGeometry(): BufferGeometry {
		const g = new BufferGeometry();
		g.setAttribute('position', new Float32BufferAttribute(this.position, 3));
		g.setAttribute('normal', new Float32BufferAttribute(this.normal, 3));
		return g;
	}
}

const norm = (v: V3): V3 => {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function ring(points: Pt[], scale: number, y: number): V3[] {
	return points.map(([x, z]) => [x * scale, y, -z * scale]);
}

// A band between two rings of equal length. Vertex normals are smooth along fillets and split at hard
// corners (sharp-nosed types), so flat sides do not shade across a corner.
function strip(b: MeshBuilder, upper: V3[], lower: V3[], inward: boolean): void {
	const n = upper.length;
	const segNormal = (i: number): V3 => {
		const j = (i + 1) % n;
		const along = norm([upper[j][0] - upper[i][0], upper[j][1] - upper[i][1], upper[j][2] - upper[i][2]]);
		const down = norm([lower[i][0] - upper[i][0], lower[i][1] - upper[i][1], lower[i][2] - upper[i][2]]);
		let nv = norm(cross(down, along));
		const mid: V3 = [upper[i][0] + upper[j][0], 0, upper[i][2] + upper[j][2]];
		const out = nv[0] * mid[0] + nv[2] * mid[2];
		if (inward ? out > 0 : out < 0) nv = [-nv[0], -nv[1], -nv[2]];
		return nv;
	};
	const normals = Array.from({ length: n }, (_, i) => segNormal(i));
	const vertexNormal = (v: number, seg: number): V3 => {
		const prev = normals[(v - 1 + n) % n];
		const own = normals[seg];
		const other = v === seg ? prev : normals[(v) % n];
		const cos = other[0] * own[0] + other[1] * own[1] + other[2] * own[2];
		if (cos < Math.cos((HARD_CORNER_DEG * Math.PI) / 180)) return own;
		return norm([own[0] + other[0], own[1] + other[1], own[2] + other[2]]);
	};
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const ni = vertexNormal(i, i);
		const nj = vertexNormal(j, i);
		b.tri(upper[i], upper[j], lower[j], ni, nj, nj);
		b.tri(upper[i], lower[j], lower[i], ni, nj, ni);
	}
}

function circle(r: number): Pt[] {
	return Array.from({ length: HOLE_SEGMENTS }, (_, i) => {
		const a = (i / HOLE_SEGMENTS) * Math.PI * 2;
		return [r * Math.cos(a), r * Math.sin(a)] as Pt;
	});
}

// A flat face at height y (normal up or down), with an optional round hole.
function cap(b: MeshBuilder, contour: V3[], hole: V3[] | null, up: boolean): void {
	const c2 = contour.map((p) => new Vector2(p[0], p[2]));
	const h2 = hole ? [hole.map((p) => new Vector2(p[0], p[2]))] : [];
	const faces = ShapeUtils.triangulateShape(c2, h2);
	const all = hole ? [...contour, ...hole] : contour;
	const nv: V3 = [0, up ? 1 : -1, 0];
	for (const [i, j, k] of faces) b.tri(all[i], all[j], all[k], nv, nv, nv);
}

export function buildInsertGeometry(geom: InsertGeometry, outline: InsertOutline): BufferGeometry {
	const t = geom.thicknessMm;
	const r = geom.icMm / 2;
	const bevel = Math.min(BEVEL_MM, t / 4, r / 8);
	const inset = (r - bevel) / r; // the flat face is the outline pulled in by the bevel
	const top = t / 2;
	const bottom = -t / 2;
	const pts = outline.points;

	const b = new MeshBuilder();
	const faceTop = ring(pts, inset, top);
	const rimTop = ring(pts, wallScale(geom, top - bevel), top - bevel);
	const rimBottom = ring(pts, wallScale(geom, bottom + bevel), bottom + bevel);
	const faceBottom = ring(pts, wallScale(geom, bottom) * inset, bottom);

	// The hole: cylindrical, or with a 90 degree countersink at the top.
	const rHole = geom.holeDiameterMm ? Math.min(geom.holeDiameterMm / 2, r * 0.6) : 0;
	let topHole: V3[] | null = null;
	let bottomHole: V3[] | null = null;
	if (rHole > 0) {
		const rSink = geom.holeCountersunk ? Math.min(rHole * 1.5, r * 0.75) : rHole;
		const sinkDepth = Math.min(rSink - rHole, t * 0.5);
		const flat = (rad: number, y: number): V3[] => circle(rad).map(([x, z]) => [x, y, -z] as V3);
		topHole = flat(rSink, top);
		bottomHole = flat(rHole, bottom);
		if (sinkDepth > 0) strip(b, topHole, flat(rHole, top - sinkDepth), true);
		strip(b, flat(rHole, top - sinkDepth), bottomHole, true);
	}

	cap(b, faceTop, topHole, true);
	strip(b, faceTop, rimTop, false);
	strip(b, rimTop, rimBottom, false);
	strip(b, rimBottom, faceBottom, false);
	cap(b, faceBottom, bottomHole, false);
	return b.toGeometry();
}

// The reference mark: a flat triangle, raised a little off the top face, pointing at corner 0. Its size and place
// (markDistance, shared with the 2D drawing) scale with the insert.
export { markDistance };
const MARK_HEIGHT_MM = 0.12;

// Null when no arrow fits the face (a very small insert).
export function buildReferenceMark(geom: InsertGeometry, outline: InsertOutline): BufferGeometry | null {
	const placed = markDistance(geom, outline);
	if (!placed) return null;
	const { size, centre } = placed;
	const shape = new Shape(markVertices(outline.corners[0].bisectorDeg, size, centre).map(([x, y]) => new Vector2(x, y)));
	const g = new ExtrudeGeometry(shape, { depth: MARK_HEIGHT_MM, bevelEnabled: false });
	g.rotateX(-Math.PI / 2);
	g.translate(0, geom.thicknessMm / 2 - 0.01, 0);
	return g;
}

// --- edge segments -------------------------------------------------------------------------------------

const lerp2 = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// The outline points of one corner's nose arc, with the points just outside it: the previous corner's last point
// (`before`) and the next corner's first (`after`), so the straight sides beside the arc run from `run[0]` to
// `before` and from `run[last]` to `after` (top-view coordinates).
export function arcRun(geom: InsertGeometry, outline: InsertOutline, corner: number): { run: Pt[]; before: Pt; after: Pt } | null {
	const pts = outline.points;
	const n = pts.length;
	const c = outline.corners[corner];
	if (!c || n === 0) return null;
	let inArc: boolean[];
	if (geom.shape === 'R') {
		const half = (360 / geom.cornerCount) * 0.25;
		inArc = pts.map(([x, y]) => {
			const deg = (Math.atan2(y, x) * 180) / Math.PI;
			const diff = Math.abs((((deg - c.bisectorDeg) % 360) + 540) % 360 - 180);
			return diff <= half + 1e-6;
		});
	} else {
		const re = Math.min(Math.max(geom.noseRadiusMm, 0), (geom.icMm / 2) * 0.99);
		inArc = pts.map(([x, y]) => Math.abs(Math.hypot(x - c.x, y - c.y) - re) < 1e-4);
	}
	let start = inArc.findIndex((v, i) => v && !inArc[(i - 1 + n) % n]);
	if (start < 0) {
		start = inArc.findIndex((v) => v);
		if (start < 0) return null;
	}
	const run: Pt[] = [];
	for (let k = 0; k < n && inArc[(start + k) % n]; k++) run.push(pts[(start + k) % n]);
	return { run, before: pts[(start - 1 + n) % n], after: pts[(start + run.length) % n] };
}

// The outline run that is one edge: the nose arc plus a quarter of each side beside it (top-view coordinates).
export function edgeRun(geom: InsertGeometry, outline: InsertOutline, corner: number): Pt[] {
	const arc = arcRun(geom, outline, corner);
	if (!arc) return [];
	const { run, before, after } = arc;
	return [lerp2(run[0], before, EDGE_SIDE_FRACTION), ...run, lerp2(run[run.length - 1], after, EDGE_SIDE_FRACTION)];
}

// World-oriented sweep path of one edge, sitting on the bevel of the top or bottom face.
export function edgePath(geom: InsertGeometry, outline: InsertOutline, placement: EdgePlacement): V3[] {
	const run = edgeRun(geom, outline, placement.corner);
	const bevel = Math.min(BEVEL_MM, geom.thicknessMm / 4);
	const y = placement.face === 'top' ? geom.thicknessMm / 2 - bevel / 2 : -geom.thicknessMm / 2 + bevel / 2;
	const s = wallScale(geom, y);
	return run.map(([x, z]) => [x * s, y, -z * s]);
}

// A round tube swept along a polyline in the horizontal plane (no end caps: the ends are tangent to the side).
export function sweepTube(path: V3[], radius: number, sides = TUBE_SIDES): BufferGeometry {
	const pos: number[] = [];
	const nor: number[] = [];
	const idx: number[] = [];
	const m = path.length;
	for (let i = 0; i < m; i++) {
		const a = path[Math.max(0, i - 1)];
		const c = path[Math.min(m - 1, i + 1)];
		const tangent = norm([c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
		const side = norm(cross(tangent, [0, 1, 0]));
		for (let s = 0; s < sides; s++) {
			const ang = (s / sides) * Math.PI * 2;
			const nx = side[0] * Math.cos(ang);
			const ny = Math.sin(ang);
			const nz = side[2] * Math.cos(ang);
			pos.push(path[i][0] + nx * radius, path[i][1] + ny * radius, path[i][2] + nz * radius);
			nor.push(nx, ny, nz);
		}
	}
	for (let i = 0; i < m - 1; i++) {
		for (let s = 0; s < sides; s++) {
			const a = i * sides + s;
			const b = i * sides + ((s + 1) % sides);
			const c = (i + 1) * sides + s;
			const d = (i + 1) * sides + ((s + 1) % sides);
			idx.push(a, c, b, b, c, d);
		}
	}
	const g = new BufferGeometry();
	g.setAttribute('position', new Float32BufferAttribute(pos, 3));
	g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
	g.setIndex(idx);
	return g;
}

// One geometry per (face, corner, radius), shared by every insert of the box.
export class EdgeGeometryCache {
	private readonly cache = new Map<string, BufferGeometry>();
	constructor(private readonly geom: InsertGeometry, private readonly outline: InsertOutline) {}

	get(placement: EdgePlacement, radius = EDGE_TUBE_RADIUS_MM): BufferGeometry {
		const key = `${placement.face}:${placement.corner}:${radius}`;
		let g = this.cache.get(key);
		if (!g) {
			g = sweepTube(edgePath(this.geom, this.outline, placement), radius);
			this.cache.set(key, g);
		}
		return g;
	}

	get size(): number { return this.cache.size; }

	dispose(): void {
		for (const g of this.cache.values()) g.dispose();
		this.cache.clear();
	}
}

export interface EdgeUserData { kind: 'edge'; insertId: string; edgeId: string }

// One pickable mesh per placed edge of an insert (edges without a placement have no segment).
export function createEdgeSegments(
	insert: ToolingInsert, cache: EdgeGeometryCache, material: Material, radius = EDGE_TUBE_RADIUS_MM,
): Mesh[] {
	const meshes: Mesh[] = [];
	for (const e of insert.edges) {
		if (!e.placement) continue;
		const m = new Mesh(cache.get(e.placement, radius), material);
		m.userData = { kind: 'edge', insertId: insert.id, edgeId: e.id } satisfies EdgeUserData;
		m.name = `edge ${e.code}`;
		meshes.push(m);
	}
	return meshes;
}

// Where an edge's letter pill sits: just outside the corner, at the face (insert-local, world orientation).
export function edgeAnchor(geom: InsertGeometry, outline: InsertOutline, placement: EdgePlacement): V3 {
	const c = outline.corners[placement.corner];
	const a = (c.bisectorDeg * Math.PI) / 180;
	const reach = (geom.shape === 'R' ? 0 : geom.noseRadiusMm) + 1.1;
	const y = placement.face === 'top' ? geom.thicknessMm / 2 : -geom.thicknessMm / 2;
	return [c.x + Math.cos(a) * reach, y, -(c.y + Math.sin(a) * reach)];
}
