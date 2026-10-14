// Camera framings and the eased move between them. Pure maths (no three.js, no DOM beyond matchMedia),
// so it is tested in Node. A framing is a target plus a spherical offset: the camera sits `distance` from
// the target, `polar` from straight up and `azimuth` around y (0 = on the +z side, toward the viewer).

import type { EdgePlacement, InsertGeometry, InsertOutline } from '@d1/ui';

export type Vec3 = [number, number, number];

export interface Framing {
	position: Vec3;
	target: Vec3;
	distance: number;
	polar: number; // radians from +y
	azimuth: number; // radians
}

export const FOV_DEG = 32;
export const MOVE_MS = 400;
export const POLAR_MIN = (15 * Math.PI) / 180;
export const POLAR_MAX = (80 * Math.PI) / 180;
export const ZOOM_IN = 0.5; // closest the user may orbit in, times the framing distance
export const ZOOM_OUT = 3; // farthest

const RAD = Math.PI / 180;
const INSERT_POLAR = 42 * RAD;
const EDGE_POLAR_TOP = 62 * RAD;
const EDGE_POLAR_BOTTOM = 80 * RAD;

export function framingAt(target: Vec3, distance: number, polar: number, azimuth: number): Framing {
	const s = Math.sin(polar);
	return {
		target, distance, polar, azimuth,
		position: [
			target[0] + distance * s * Math.sin(azimuth),
			target[1] + distance * Math.cos(polar),
			target[2] + distance * s * Math.cos(azimuth),
		],
	};
}

export function framingFromCamera(position: Vec3, target: Vec3): Framing {
	const dx = position[0] - target[0], dy = position[1] - target[1], dz = position[2] - target[2];
	const distance = Math.hypot(dx, dy, dz) || 1;
	return { position, target, distance, polar: Math.acos(Math.min(1, Math.max(-1, dy / distance))), azimuth: Math.atan2(dx, dz) };
}

// Half angles of the view, vertical and horizontal.
function halfAngles(aspect: number, fovDeg: number): { v: number; h: number } {
	const v = (fovDeg * RAD) / 2;
	return { v, h: Math.atan(Math.tan(v) * Math.max(0.2, aspect)) };
}

// The distance at which a thing of `halfW` x `halfH` (in view space) just fits, with `pad` as a ratio.
function fitDistance(halfW: number, halfH: number, aspect: number, fovDeg: number, pad: number): number {
	const a = halfAngles(aspect, fovDeg);
	return Math.max((halfW * pad) / Math.tan(a.h), (halfH * pad) / Math.tan(a.v));
}

// The tray's polar angle: steep enough that a tall tray fills a portrait stage (the tray's projected shape
// matches the stage's), never flatter than 52 degrees from straight up, never more top-down than 30.
const BOX_POLAR_MIN = 30 * RAD;
const BOX_POLAR_MAX = 52 * RAD;
const BOX_PAD = 1.1;

// Smallest camera distance at which the tray's eight corners all sit inside the frame (with `pad` as a ratio),
// from the pinhole model, so the near edge's perspective is counted. The camera looks at `target` from
// `polar`, on the +z side.
function fitTray(
	tray: { width: number; depth: number; topY: number }, target: Vec3, polar: number, aspect: number, fovDeg: number, pad: number,
): number {
	const { v, h } = halfAngles(aspect, fovDeg);
	const tv = Math.tan(v), th = Math.tan(h);
	const c: Vec3 = [0, Math.cos(polar), Math.sin(polar)]; // from the target toward the camera
	const up: Vec3 = [0, Math.sin(polar), -Math.cos(polar)];
	const rels: Vec3[] = [];
	for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, tray.topY]) {
		rels.push([(sx * tray.width) / 2 - target[0], y - target[1], (sz * tray.depth) / 2 - target[2]]);
	}
	const fits = (d: number): boolean => rels.every((p) => {
		const depth = d - (p[1] * c[1] + p[2] * c[2]);
		if (depth <= 0.5) return false;
		return Math.abs(p[0]) / (depth * th) <= 1 / pad && Math.abs(p[1] * up[1] + p[2] * up[2]) / (depth * tv) <= 1 / pad;
	});
	let lo = 1, hi = 8;
	while (!fits(hi) && hi < 1e6) hi *= 2;
	for (let i = 0; i < 40; i++) {
		const mid = (lo + hi) / 2;
		if (fits(mid)) hi = mid; else lo = mid;
	}
	return hi;
}

// A one-insert case is framed close and at a fixed, friendlier angle: it fills the stage, so the insert in it
// does too (about 60%).
const CASE_POLAR = 40 * RAD;
const CASE_PAD = 1.04;

export function frameBox(
	tray: { width: number; depth: number; topY: number; single?: boolean }, aspect: number, fovDeg = FOV_DEG,
): Framing {
	const a = Math.max(0.2, aspect);
	const polar = tray.single
		? CASE_POLAR
		: Math.min(BOX_POLAR_MAX, Math.max(BOX_POLAR_MIN, Math.acos(Math.min(1, tray.width / (a * tray.depth)))));
	const target: Vec3 = [0, tray.topY * 0.4, 0];
	return framingAt(target, fitTray(tray, target, polar, a, fovDeg, tray.single ? CASE_PAD : BOX_PAD), polar, 0);
}

// The reach of an insert from its centre: the farthest corner tip.
export function insertReach(geom: InsertGeometry, outline: InsertOutline): number {
	const nose = geom.shape === 'R' ? 0 : geom.noseRadiusMm;
	return Math.max(geom.icMm / 2, ...outline.corners.map((c) => Math.hypot(c.x, c.y) + nose));
}

export function frameInsert(
	centre: Vec3, geom: InsertGeometry, outline: InsertOutline, aspect: number, fovDeg = FOV_DEG,
): Framing {
	const reach = insertReach(geom, outline);
	// Room around the outline for the lettered pills.
	const distance = fitDistance(reach, reach * Math.cos(INSERT_POLAR) + geom.thicknessMm, aspect, fovDeg, 1.45);
	return framingAt([centre[0], centre[1], centre[2]], distance, INSERT_POLAR, 0);
}

// Looks at one corner along its bisector from outside, slightly from above, near enough to read the nose radius.
export function frameEdge(
	centre: Vec3, geom: InsertGeometry, outline: InsertOutline, placement: EdgePlacement, aspect: number,
	fovDeg = FOV_DEG,
): Framing {
	const c = outline.corners[placement.corner] ?? outline.corners[0];
	const a = (c.bisectorDeg * RAD);
	const dir: [number, number] = [Math.cos(a), -Math.sin(a)]; // world x, z
	const re = geom.shape === 'R' ? 0 : geom.noseRadiusMm;
	const tip = Math.hypot(c.x, c.y) + re;
	const reach = Math.max(tip - 0.6, 0);
	const faceY = placement.face === 'top' ? geom.thicknessMm / 2 : -geom.thicknessMm / 2;
	const target: Vec3 = [centre[0] + dir[0] * reach, centre[1] + faceY, centre[2] + dir[1] * reach];
	// Visible height in mm: about 18 x the nose radius, so the radius reads and the insert's shape still shows.
	const span = Math.min(24, Math.max(12, re * 18));
	const distance = fitDistance(span / 2, span / 2, aspect, fovDeg, 1);
	const polar = placement.face === 'top' ? EDGE_POLAR_TOP : EDGE_POLAR_BOTTOM;
	return framingAt(target, distance, polar, Math.atan2(dir[0], dir[1]));
}

export interface OrbitLimits { minDistance: number; maxDistance: number; minPolar: number; maxPolar: number }
export function orbitLimits(f: Framing): OrbitLimits {
	return { minDistance: f.distance * ZOOM_IN, maxDistance: f.distance * ZOOM_OUT, minPolar: POLAR_MIN, maxPolar: POLAR_MAX };
}

// --- the ease ------------------------------------------------------------------------------------------

export function easeInOutCubic(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Eased progress after `elapsedMs` of a `durationMs` move; a zero duration is already there.
export function easeStep(elapsedMs: number, durationMs: number): number {
	return durationMs <= 0 ? 1 : easeInOutCubic(elapsedMs / durationMs);
}

export function prefersReducedMotion(): boolean {
	try {
		return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

export function moveDuration(reduced = prefersReducedMotion()): number {
	return reduced ? 0 : MOVE_MS;
}

const TAU = Math.PI * 2;
const shortestArc = (from: number, to: number): number => ((((to - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI;

// In between two framings: the target slides, the zoom is geometric and the orbit angles take the short way.
export function interpolateFraming(a: Framing, b: Framing, t: number): Framing {
	if (t <= 0) return a;
	if (t >= 1) return b;
	const lerp = (x: number, y: number) => x + (y - x) * t;
	const target: Vec3 = [lerp(a.target[0], b.target[0]), lerp(a.target[1], b.target[1]), lerp(a.target[2], b.target[2])];
	const distance = a.distance * Math.pow(b.distance / a.distance, t);
	return framingAt(target, distance, lerp(a.polar, b.polar), a.azimuth + shortestArc(a.azimuth, b.azimuth) * t);
}

// A move in progress. `eased(now)` is the 0..1 progress that framings and other animated values share.
export class FramingTween {
	private from: Framing | null = null;
	private to: Framing | null = null;
	private t0 = 0;
	private duration = 0;

	start(from: Framing, to: Framing, now: number, durationMs: number): void {
		this.from = from;
		this.to = to;
		this.t0 = now;
		this.duration = durationMs;
	}

	get active(): boolean { return this.to !== null; }

	eased(now: number): number { return easeStep(now - this.t0, this.duration); }

	// The framing for this instant, and whether the move is over (the tween then clears itself).
	sample(now: number): { framing: Framing; done: boolean } | null {
		if (!this.from || !this.to) return null;
		const e = this.eased(now);
		const framing = interpolateFraming(this.from, this.to, e);
		const done = e >= 1;
		if (done) { this.from = null; this.to = null; }
		return { framing, done };
	}

	cancel(): void { this.from = null; this.to = null; }
}
