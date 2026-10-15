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

// The tray's polar angle: a steep, nearly plan view that still shows the tray is 3D. Steep enough that a tall tray
// fills a portrait stage (the tray's projected shape matches the stage's), never flatter than 34 degrees from straight
// up (an elevation of 56), never more top-down than 18. It was 36 to 52; the tray now looks about 18 degrees steeper.
const BOX_POLAR_MIN = 18 * RAD;
const BOX_POLAR_MAX = 34 * RAD;
const BOX_PAD = 1.1;
// The near end of the tray looks wider than the far end, so aim for a slightly taller projection than the stage's own shape.
const PERSPECTIVE_ASPECT = 0.88;

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

// The vertical extent of the tray's corners in normalised screen space (-1 to 1) from the given camera.
function trayNdcY(
	tray: { width: number; depth: number; topY: number }, target: Vec3, polar: number, d: number, tv: number,
): { min: number; max: number } {
	const c: Vec3 = [0, Math.cos(polar), Math.sin(polar)];
	const up: Vec3 = [0, Math.sin(polar), -Math.cos(polar)];
	let min = Infinity, max = -Infinity;
	for (const sz of [-1, 1]) for (const y of [0, tray.topY]) {
		const rel: Vec3 = [0, y - target[1], (sz * tray.depth) / 2 - target[2]];
		const depth = d - (rel[1] * c[1] + rel[2] * c[2]);
		const ndc = (rel[1] * up[1] + rel[2] * up[2]) / (depth * tv);
		min = Math.min(min, ndc);
		max = Math.max(max, ndc);
	}
	return { min, max };
}

export function frameBox(
	tray: { width: number; depth: number; topY: number; single?: boolean }, aspect: number, fovDeg = FOV_DEG,
): Framing {
	const a = Math.max(0.2, aspect);
	const polar = tray.single
		? CASE_POLAR
		: Math.min(BOX_POLAR_MAX, Math.max(BOX_POLAR_MIN, Math.acos(Math.min(1, tray.width / (PERSPECTIVE_ASPECT * a * tray.depth)))));
	const pad = tray.single ? CASE_PAD : BOX_PAD;
	let target: Vec3 = [0, tray.topY * 0.4, 0];
	let distance = fitTray(tray, target, polar, a, fovDeg, pad);
	// Perspective makes the near end of the tray larger, so the tray sits low in the frame: slide the target
	// along the view's up axis until it is centred, and fit again.
	const up: Vec3 = [0, Math.sin(polar), -Math.cos(polar)];
	const tv = Math.tan((fovDeg * RAD) / 2);
	for (let i = 0; i < 3; i++) {
		const ndc = trayNdcY(tray, target, polar, distance, tv);
		const shift = ((ndc.max + ndc.min) / 2) * distance * tv;
		target = [target[0] + up[0] * shift, target[1] + up[1] * shift, target[2] + up[2] * shift];
		distance = fitTray(tray, target, polar, a, fovDeg, pad);
	}
	return framingAt(target, distance, polar, 0);
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

// --- limited rotation ------------------------------------------------------------------------------------
// The view can be turned a little each way from a framing's own view, not all the way round: about 10 degrees left or
// right, and about 8 degrees up or down, never lower than 15 degrees above the tray plane and never past straight
// down. The bounds are relative to the framing, so the box, an insert and an edge each turn around their own default.
// They are soft, like a spring: dragging past a bound meets rising resistance (`rubberStep`: the view moves less and
// less per pixel and can never pass the bound by more than about 6 degrees), and on release it springs back to the
// bound (`springToBounds`: short, slightly damped, no visible bounce). OrbitControls is given the bounds plus that
// maximum overshoot as its hard limits, and re-reads the camera every frame, so the resistance is applied to each
// frame's step (`rubberView`). Once the user lets go and stays still, the view recentres (RECENTRE_DELAY_MS).

export const AZIMUTH_RANGE = 10 * RAD;
export const POLAR_RANGE = 8 * RAD;
export const MIN_ELEVATION = 15 * RAD; // the lowest the camera goes, above the tray's plane
export const POLAR_FLOOR = 3 * RAD; // the most top-down: just short of straight down, where the orbit is degenerate
export const MAX_OVERSHOOT = 6 * RAD; // the most a drag can take the view past a soft bound
export const SPRING_OMEGA = 18; // rad/s: the spring-back settles in about 300 ms
export const SPRING_ZETA = 0.85; // a little under critical: a bounce of about 0.6 % of the overshoot, which is invisible
export const RECENTRE_DELAY_MS = 1500; // after the user stops: recentre on the focus's own framing
const SNAP = 0.0005; // radians; closer than this to a bound counts as on it

export interface Rotation { minAzimuth: number; maxAzimuth: number; minPolar: number; maxPolar: number }

// The soft bounds around a framing's view. The framing's own view is always inside them.
export function rotationBounds(f: Framing): Rotation {
	return {
		minAzimuth: f.azimuth - AZIMUTH_RANGE,
		maxAzimuth: f.azimuth + AZIMUTH_RANGE,
		minPolar: Math.min(f.polar, Math.max(POLAR_FLOOR, f.polar - POLAR_RANGE)),
		maxPolar: Math.max(f.polar, Math.min(Math.PI / 2 - MIN_ELEVATION, f.polar + POLAR_RANGE)),
	};
}

// The bounds plus the most a drag may overshoot into (what OrbitControls enforces as its hard limits).
export function hardBounds(f: Framing): Rotation {
	const b = rotationBounds(f);
	return {
		minAzimuth: b.minAzimuth - MAX_OVERSHOOT,
		maxAzimuth: b.maxAzimuth + MAX_OVERSHOOT,
		minPolar: Math.max(0.01, b.minPolar - MAX_OVERSHOOT),
		maxPolar: Math.max(b.maxPolar, Math.min(Math.PI / 2 - 5 * RAD, b.maxPolar + MAX_OVERSHOOT)),
	};
}

// The rubber band: how far past a bound the view sits when dragged `x` past it (radians). One to one at first, then less
// and less, never past `max`: the further out, the harder the pull.
export function rubberBand(x: number, max = MAX_OVERSHOOT): number {
	return x <= 0 ? x : max * (1 - Math.exp(-x / max));
}

// The drag it takes to be `overshoot` past a bound (the inverse of `rubberBand`).
export function rubberBandInverse(overshoot: number, max = MAX_OVERSHOOT): number {
	if (overshoot <= 0) return overshoot;
	return -max * Math.log(1 - Math.min(overshoot / max, 1 - 1e-9));
}

// One step of a drag on a bound. `excess` is how far past it the view is (negative: inside it, short of the bound) and
// `delta` the step the drag asked for: back to how far the drag has gone, add the step, and map it through the band.
// Inside the bound steps are free; past it each step is damped by how far past it already is.
export function rubberStep(excess: number, delta: number, max = MAX_OVERSHOOT): number {
	const dragged = rubberBandInverse(excess, max) + delta;
	return rubberBand(dragged, max);
}

// An angle `p` taken by `delta` between two bounds, with the band at either one.
function rubberAxis(p: number, delta: number, lo: number, hi: number, max: number): number {
	if (p > hi || p + delta > hi) return hi + rubberStep(p - hi, delta, max);
	if (p < lo || p + delta < lo) return lo - rubberStep(lo - p, -delta, max);
	return p + delta;
}

// The view `next` that the orbit controls just produced from `prev`, with the step's azimuth and polar run through the
// rubber band at the soft bounds `b` (distance and target as `next` has them), or null when the step is not past one.
export function rubberView(prev: Framing, next: Framing, b: Rotation, max = MAX_OVERSHOOT): Framing | null {
	const centre = (b.minAzimuth + b.maxAzimuth) / 2;
	const half = (b.maxAzimuth - b.minAzimuth) / 2;
	const offPrev = shortestArc(centre, prev.azimuth);
	const dAz = shortestArc(prev.azimuth, next.azimuth);
	const dPolar = next.polar - prev.polar;
	const off = rubberAxis(offPrev, dAz, -half, half, max);
	const polar = rubberAxis(prev.polar, dPolar, b.minPolar, b.maxPolar, max);
	if (Math.abs(off - (offPrev + dAz)) < 1e-9 && Math.abs(polar - next.polar) < 1e-9) return null;
	return framingAt(next.target, next.distance, polar, centre + off);
}

// One step of a spring settling `x` to 0 from the state (x, v), the exact solution for a damped spring, so it is the
// same at any frame rate (two half steps are one whole step). `dtMs` is capped so a stalled frame does not leap.
export function springStep(x: number, v: number, dtMs: number, omega = SPRING_OMEGA, zeta = SPRING_ZETA): { x: number; v: number } {
	const t = Math.min(100, Math.max(0, dtMs)) / 1000;
	const wd = omega * Math.sqrt(1 - zeta * zeta);
	const e = Math.exp(-zeta * omega * t);
	const c = Math.cos(wd * t);
	const s = Math.sin(wd * t);
	return {
		x: e * (x * c + ((v + zeta * omega * x) / wd) * s),
		v: e * (v * c - ((zeta * omega * v + omega * omega * x) / wd) * s),
	};
}

export interface SpringVelocity { azimuth: number; polar: number } // rad/s, along the way back to the bound

// A view outside the soft bounds, sprung back toward them for a frame of `dtMs`: the new view and the new velocity, or
// null when the view is inside (or within a hair of) the bounds. Distance and target are kept. Azimuth is measured from
// the bounds' middle, the short way round. `reduced` lands on the bound at once (reduced motion).
export function springToBounds(
	view: Framing, b: Rotation, vel: SpringVelocity, dtMs: number, reduced = false,
): { view: Framing; vel: SpringVelocity } | null {
	const centre = (b.minAzimuth + b.maxAzimuth) / 2;
	const half = (b.maxAzimuth - b.minAzimuth) / 2;
	const off = shortestArc(centre, view.azimuth);
	// Past which bound (+1 the upper, -1 the lower, 0 neither), and by how much.
	const sideAz = off > half ? 1 : off < -half ? -1 : 0;
	const sidePolar = view.polar > b.maxPolar ? 1 : view.polar < b.minPolar ? -1 : 0;
	const exAz = sideAz === 0 ? 0 : sideAz * off - half;
	const exPolar = sidePolar === 0 ? 0 : sidePolar * (view.polar - (sidePolar > 0 ? b.maxPolar : b.minPolar));
	if (exAz < SNAP && exPolar < SNAP) return null;
	const axis = (ex: number, v: number): { ex: number; v: number } => {
		if (ex < SNAP) return { ex: 0, v: 0 };
		if (reduced) return { ex: 0, v: 0 };
		const n = springStep(ex, v, dtMs);
		return n.x < SNAP && Math.abs(n.v) < 0.01 ? { ex: 0, v: 0 } : { ex: Math.max(0, n.x), v: n.v };
	};
	const az = axis(exAz, vel.azimuth);
	const po = axis(exPolar, vel.polar);
	const nextOff = sideAz === 0 ? off : sideAz * (half + az.ex);
	const nextPolar = sidePolar === 0 ? view.polar : sidePolar > 0 ? b.maxPolar + po.ex : b.minPolar - po.ex;
	return { view: framingAt(view.target, view.distance, nextPolar, centre + nextOff), vel: { azimuth: az.v, polar: po.v } };
}

// Whether two framings are the same view (to within a hair): a view already on its focus's framing is not recentred.
export function framingsClose(a: Framing, b: Framing): boolean {
	const dist = Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]);
	return dist < 0.05 && Math.abs(a.distance / b.distance - 1) < 0.002 && Math.abs(a.polar - b.polar) < 0.002
		&& Math.abs(shortestArc(a.azimuth, b.azimuth)) < 0.002;
}

// The bounds widened, if need be, to take in a view that lies outside them (the camera was grabbed mid-move, far from
// where it is going): so grabbing the camera never makes it jump, and `springToBounds` then draws it back in.
export function boundsContaining(b: Rotation, view: Framing): Rotation {
	const centre = (b.minAzimuth + b.maxAzimuth) / 2;
	const off = shortestArc(centre, view.azimuth);
	const half = (b.maxAzimuth - b.minAzimuth) / 2;
	return {
		minAzimuth: centre + Math.min(-half, off - SNAP),
		maxAzimuth: centre + Math.max(half, off + SNAP),
		minPolar: Math.min(b.minPolar, view.polar - SNAP),
		maxPolar: Math.max(b.maxPolar, view.polar + SNAP),
	};
}

export interface OrbitLimits extends Rotation { minDistance: number; maxDistance: number }
export function orbitLimits(f: Framing): OrbitLimits {
	return { minDistance: f.distance * ZOOM_IN, maxDistance: f.distance * ZOOM_OUT, ...hardBounds(f) };
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
