import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { buildToolingModel } from '@d1/ui';
import {
	easeInOutCubic, easeStep, frameBox, frameEdge, frameInsert, FramingTween, framingAt, framingFromCamera,
	interpolateFraming, moveDuration, MOVE_MS, orbitLimits, POLAR_MAX, POLAR_MIN, prefersReducedMotion, ZOOM_IN, ZOOM_OUT,
	type Vec3,
} from './cameraRig';
import { trayLayout } from './trayMesh';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-1' };
const ins = Array.from({ length: 10 }, (_, i) => ({ insert_id: `i${i}`, insert_code: `X-${i}`, insert_number: i + 1, is_depleted: false }));
const model = buildToolingModel(box, { iso_designation: 'CNMG 12 04 08-MF' }, ins, []);
const layout = trayLayout(model);
const centre: Vec3 = [10, 5, -4];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('framings', () => {
	it('frameBox looks at the tray from the front, above, and fits it', () => {
		const f = frameBox(layout, 2.2);
		expect(f.position[1]).toBeGreaterThan(f.target[1]);
		expect(f.position[2]).toBeGreaterThan(f.target[2]); // from the +z (viewer) side
		expect(f.target[0]).toBe(0);
		expect(dist(f.position, f.target)).toBeCloseTo(f.distance, 6);
		// the whole tray width fits the horizontal view
		const halfH = Math.atan(Math.tan((32 * Math.PI) / 360) * 2.2);
		expect(f.distance * Math.tan(halfH)).toBeGreaterThan(layout.width / 2);
	});

	// The tray's eight corners seen through the framing's camera: the box they span in normalised screen space.
	function screenExtent(l: Pick<typeof layout, 'width' | 'depth' | 'topY'> & { single?: boolean }, aspect: number): { x: number; y: number } {
		const f = frameBox(l, aspect);
		const cam = new PerspectiveCamera(32, aspect, 1, 3000);
		cam.position.set(...f.position);
		cam.lookAt(new Vector3(...f.target));
		cam.updateMatrixWorld();
		cam.updateProjectionMatrix();
		let x = 0, y = 0;
		for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const py of [0, l.topY]) {
			const p = new Vector3(sx * l.width / 2, py, sz * l.depth / 2).project(cam);
			x = Math.max(x, Math.abs(p.x));
			y = Math.max(y, Math.abs(p.y));
		}
		return { x, y };
	}

	it('fills a portrait stage with the tall tray, all of it inside the frame', () => {
		const e = screenExtent(layout, 360 / 560);
		expect(layout.depth).toBeGreaterThan(layout.width);
		expect(Math.max(e.x, e.y)).toBeLessThanOrEqual(1);
		expect(Math.max(e.x, e.y)).toBeGreaterThan(0.8); // fills it, not a small tray in the middle
	});

	it('still fits the tray when the stage is square or landscape (the narrow, stacked layout)', () => {
		for (const aspect of [1, 1.6, 2.5]) {
			const e = screenExtent(layout, aspect);
			expect(Math.max(e.x, e.y)).toBeLessThanOrEqual(1);
		}
	});

	it('a wider tray fits too: 3 x 4 and 5 x 10 in the portrait stage', () => {
		const grid = (n: number) => trayLayout(buildToolingModel(box, { iso_designation: 'CNMG 12 04 08-MF' }, Array.from({ length: n }, (_, i) => ({ insert_id: `i${i}`, insert_code: `X-${i}`, insert_number: i + 1, is_depleted: false })), []));
		for (const n of [4, 12, 50]) {
			const e = screenExtent(grid(n), 360 / 560);
			expect(Math.max(e.x, e.y)).toBeLessThanOrEqual(1);
			expect(Math.max(e.x, e.y)).toBeGreaterThan(0.75);
		}
	});

	it('frames a one-insert case close: the insert fills about 60% of the portrait stage, nothing clipped', () => {
		const pcd = { iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate: 'PCD' };
		const oneModel = buildToolingModel(box, pcd, [ins[0]], []);
		const l = trayLayout(oneModel);
		expect(l.single).toBe(true);
		const aspect = 340 / 520;
		const e = screenExtent(l, aspect);
		expect(Math.max(e.x, e.y)).toBeLessThanOrEqual(1);
		// The insert itself: its widest reach across (x) and along (z) the case, resting in the pocket.
		const f = frameBox(l, aspect);
		const cam = new PerspectiveCamera(32, aspect, 1, 3000);
		cam.position.set(...f.position);
		cam.lookAt(new Vector3(...f.target));
		cam.updateMatrixWorld();
		cam.updateProjectionMatrix();
		const xs = oneModel.outline.points.map((p) => p[0]);
		const ys = oneModel.outline.points.map((p) => p[1]);
		let sx = 0, sy = 0;
		for (const x of [Math.min(...xs), Math.max(...xs)]) for (const y of [Math.min(...ys), Math.max(...ys)]) {
			const p = new Vector3(x, l.insertY, -y).project(cam);
			sx = Math.max(sx, Math.abs(p.x));
			sy = Math.max(sy, Math.abs(p.y));
		}
		const fill = Math.max(sx, sy); // fraction of the half-frame, so of the stage's limiting side
		expect(fill).toBeGreaterThan(0.5);
		expect(fill).toBeLessThan(0.72);
	});

	it('frameInsert is centred on the insert and closer than the box', () => {
		const f = frameInsert(centre, model.geometry, model.outline, 2.2);
		expect(f.target).toEqual(centre);
		expect(f.distance).toBeLessThan(frameBox(layout, 2.2).distance);
		expect(f.polar).toBeGreaterThan(POLAR_MIN);
		expect(f.polar).toBeLessThan(POLAR_MAX);
	});

	it('frameEdge looks along the corner bisector, from outside and slightly above', () => {
		const a = frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 0 }, 2.2);
		// corner 0 points to -z: the camera sits on that side of the insert, above the top face
		expect(a.position[2]).toBeLessThan(centre[2] - 5);
		expect(Math.abs(a.position[0] - centre[0])).toBeLessThan(1e-6);
		expect(a.position[1]).toBeGreaterThan(centre[1] + model.geometry.thicknessMm / 2);
		// corner 2 is the opposite one
		const c = frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 2 }, 2.2);
		expect(c.position[2]).toBeGreaterThan(centre[2] + 5);
	});

	it('frameEdge is close enough to read the nose radius (the view is about 18 x RE high)', () => {
		const f = frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 0 }, 2.2);
		const insert = frameInsert(centre, model.geometry, model.outline, 2.2);
		expect(f.distance).toBeLessThan(insert.distance * 0.6);
		const visibleHeight = 2 * f.distance * Math.tan((32 * Math.PI) / 360);
		expect(visibleHeight).toBeCloseTo(model.geometry.noseRadiusMm * 18, 0);
		// the nose is still wide enough on screen to read: at least 4% of the view height
		expect(model.geometry.noseRadiusMm / visibleHeight).toBeGreaterThan(0.04);
	});

	it('frameEdge targets the underside for a bottom edge, from a flatter angle', () => {
		const top = frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 0 }, 2.2);
		const bottom = frameEdge(centre, model.geometry, model.outline, { face: 'bottom', corner: 0 }, 2.2);
		expect(bottom.target[1]).toBeLessThan(centre[1]);
		expect(top.target[1]).toBeGreaterThan(centre[1]);
		expect(bottom.polar).toBeGreaterThan(top.polar);
		expect(bottom.polar).toBeLessThanOrEqual(POLAR_MAX);
	});

	it('orbit limits are 15 to 80 degrees and 0.5x to 3x the framing', () => {
		const f = frameInsert(centre, model.geometry, model.outline, 2);
		const l = orbitLimits(f);
		expect(l.minPolar).toBeCloseTo((15 * Math.PI) / 180, 9);
		expect(l.maxPolar).toBeCloseTo((80 * Math.PI) / 180, 9);
		expect(l.minDistance).toBeCloseTo(f.distance * ZOOM_IN, 9);
		expect(l.maxDistance).toBeCloseTo(f.distance * ZOOM_OUT, 9);
	});

	it('every framing sits inside the orbit polar limits', () => {
		for (const f of [
			frameBox(layout, 2),
			frameInsert(centre, model.geometry, model.outline, 2),
			frameEdge(centre, model.geometry, model.outline, { face: 'bottom', corner: 2 }, 2),
		]) {
			expect(f.polar).toBeGreaterThanOrEqual(POLAR_MIN);
			expect(f.polar).toBeLessThanOrEqual(POLAR_MAX);
		}
	});
});

describe('framingFromCamera', () => {
	it('round-trips a framing', () => {
		const f = framingAt([1, 2, 3], 40, 0.8, -2.2);
		const back = framingFromCamera(f.position, f.target);
		expect(back.distance).toBeCloseTo(40, 6);
		expect(back.polar).toBeCloseTo(0.8, 6);
		expect(back.azimuth).toBeCloseTo(-2.2, 6);
	});
});

describe('the ease', () => {
	it('easeInOutCubic starts slow, is half way at half time and clamps', () => {
		expect(easeInOutCubic(0)).toBe(0);
		expect(easeInOutCubic(1)).toBe(1);
		expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
		expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
		expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
		expect(easeInOutCubic(-1)).toBe(0);
		expect(easeInOutCubic(3)).toBe(1);
	});

	it('is monotonic', () => {
		let last = -1;
		for (let i = 0; i <= 40; i++) {
			const v = easeInOutCubic(i / 40);
			expect(v).toBeGreaterThanOrEqual(last);
			last = v;
		}
	});

	it('easeStep covers the move in MOVE_MS (400) and is instant for a zero duration', () => {
		expect(MOVE_MS).toBe(400);
		expect(easeStep(0, 400)).toBe(0);
		expect(easeStep(200, 400)).toBeCloseTo(0.5, 9);
		expect(easeStep(400, 400)).toBe(1);
		expect(easeStep(0, 0)).toBe(1);
	});
});

describe('interpolateFraming', () => {
	const a = framingAt([0, 0, 0], 100, 0.9, 0);
	const b = framingAt([10, 4, -6], 25, 1.3, 1);

	it('hits both ends', () => {
		expect(interpolateFraming(a, b, 0)).toBe(a);
		expect(interpolateFraming(a, b, 1)).toBe(b);
	});

	it('zooms geometrically and slides the target', () => {
		const m = interpolateFraming(a, b, 0.5);
		expect(m.distance).toBeCloseTo(50, 6);
		expect(m.target).toEqual([5, 2, -3]);
		expect(dist(m.position, m.target)).toBeCloseTo(m.distance, 6);
	});

	it('takes the short way around the insert', () => {
		const from = framingAt([0, 0, 0], 20, 1, (170 * Math.PI) / 180);
		const to = framingAt([0, 0, 0], 20, 1, (-170 * Math.PI) / 180);
		const m = interpolateFraming(from, to, 0.5);
		expect(Math.abs(Math.cos(m.azimuth) + 1)).toBeLessThan(1e-6); // at 180 degrees, not at 0
	});
});

describe('FramingTween', () => {
	const a = framingAt([0, 0, 0], 100, 0.9, 0);
	const b = framingAt([10, 4, -6], 25, 1.3, 1);

	it('eases from a to b over the duration, then clears', () => {
		const t = new FramingTween();
		expect(t.active).toBe(false);
		expect(t.sample(0)).toBeNull();
		t.start(a, b, 1000, 400);
		expect(t.active).toBe(true);
		const mid = t.sample(1200)!;
		expect(mid.done).toBe(false);
		expect(mid.framing.distance).toBeCloseTo(50, 6);
		const end = t.sample(1400)!;
		expect(end.done).toBe(true);
		expect(end.framing).toBe(b);
		expect(t.active).toBe(false);
	});

	it('is done at once for a zero duration', () => {
		const t = new FramingTween();
		t.start(a, b, 5, 0);
		expect(t.sample(5)).toMatchObject({ done: true, framing: b });
	});

	it('can be cancelled', () => {
		const t = new FramingTween();
		t.start(a, b, 0, 400);
		t.cancel();
		expect(t.active).toBe(false);
	});
});

describe('prefers-reduced-motion', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('moves instantly when the media query matches, and eases otherwise', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') }));
		expect(prefersReducedMotion()).toBe(true);
		expect(moveDuration()).toBe(0);
		vi.stubGlobal('matchMedia', () => ({ matches: false }));
		expect(prefersReducedMotion()).toBe(false);
		expect(moveDuration()).toBe(400);
	});

	it('eases when matchMedia is missing', () => {
		vi.stubGlobal('matchMedia', undefined);
		expect(prefersReducedMotion()).toBe(false);
	});
});
