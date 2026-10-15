import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { buildToolingModel } from '@d1/ui';
import {
	AZIMUTH_RANGE, easeFraction, easeInOutCubic, easeStep, easeToBounds, frameBox, frameEdge, frameInsert, FramingTween, framingAt, framingFromCamera,
	boundsContaining, hardBounds, interpolateFraming, MIN_ELEVATION, moveDuration, MOVE_MS, orbitLimits, POLAR_FLOOR, POLAR_MAX, POLAR_MIN,
	POLAR_RANGE, prefersReducedMotion, rotationBounds, ZOOM_IN, ZOOM_OUT,
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

	it('looks down steeply at a tray, close to a plan view (within 18 to 34 degrees of straight down), never flat-on', () => {
		const grid = (n: number) => trayLayout(buildToolingModel(box, { iso_designation: 'CNMG 12 04 08-MF' }, Array.from({ length: n }, (_, i) => ({ insert_id: `i${i}`, insert_code: `X-${i}`, insert_number: i + 1, is_depleted: false })), []));
		const toDeg = (r: number) => (r * 180) / Math.PI;
		for (const l of [layout, grid(4), grid(50)]) {
			for (const aspect of [360 / 560, 1, 2.2]) {
				const f = frameBox(l, aspect);
				expect(toDeg(f.polar)).toBeGreaterThanOrEqual(18 - 1e-9);
				expect(toDeg(f.polar)).toBeLessThanOrEqual(34 + 1e-9);
				expect(f.azimuth).toBe(0); // still from the +z side, so the etched text reads the right way up
			}
		}
		expect(toDeg(frameBox(layout, 360 / 560).polar)).toBeLessThan(36); // steeper than the old 36 to 52
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

	it('centres the tray vertically in the frame, though its near end looks larger', () => {
		const aspect = 360 / 560;
		const f = frameBox(layout, aspect);
		const cam = new PerspectiveCamera(32, aspect, 1, 3000);
		cam.position.set(...f.position);
		cam.lookAt(new Vector3(...f.target));
		cam.updateMatrixWorld();
		cam.updateProjectionMatrix();
		const ys: number[] = [];
		for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const py of [0, layout.topY]) ys.push(new Vector3(sx * layout.width / 2, py, sz * layout.depth / 2).project(cam).y);
		expect(Math.abs(Math.max(...ys) + Math.min(...ys))).toBeLessThan(0.06);
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

	it('orbit limits are 0.5x to 3x the framing in distance, and the framing\'s hard rotation bounds', () => {
		const f = frameInsert(centre, model.geometry, model.outline, 2);
		const l = orbitLimits(f);
		expect(l).toMatchObject(hardBounds(f));
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

const RAD = Math.PI / 180;
const deg = (r: number) => r / RAD;

describe('limited rotation', () => {
	const views = () => [
		frameBox(layout, 2),
		frameBox(layout, 360 / 560),
		frameInsert(centre, model.geometry, model.outline, 2),
		frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 0 }, 2),
		frameEdge(centre, model.geometry, model.outline, { face: 'top', corner: 2 }, 2),
		frameEdge(centre, model.geometry, model.outline, { face: 'bottom', corner: 1 }, 2),
	];

	it('turns about 10 degrees left or right of the framing\'s own view', () => {
		for (const f of views()) {
			const b = rotationBounds(f);
			expect(b.minAzimuth).toBeCloseTo(f.azimuth - 10 * RAD, 9);
			expect(b.maxAzimuth).toBeCloseTo(f.azimuth + 10 * RAD, 9);
		}
		expect(AZIMUTH_RANGE).toBeCloseTo(10 * RAD, 9);
		expect(POLAR_RANGE).toBeCloseTo(8 * RAD, 9);
	});

	it('tilts about 8 degrees up or down of the framing\'s own view, so the box, an insert and an edge each have their own range', () => {
		const box = frameBox(layout, 2);
		const b = rotationBounds(box);
		expect(b.maxPolar - box.polar).toBeCloseTo(8 * RAD, 9);
		expect(box.polar - b.minPolar).toBeGreaterThan(0);
		const insert = frameInsert(centre, model.geometry, model.outline, 2);
		const i = rotationBounds(insert);
		expect(i.minPolar).toBeCloseTo(insert.polar - POLAR_RANGE, 9);
		expect(i.maxPolar).toBeCloseTo(insert.polar + POLAR_RANGE, 9);
		expect(i.minPolar).not.toBeCloseTo(b.minPolar, 3);
	});

	it('never goes lower than 15 degrees above the tray plane, nor past straight down', () => {
		for (const f of views()) {
			const b = rotationBounds(f);
			expect(b.maxPolar).toBeLessThanOrEqual(Math.max(f.polar, 90 * RAD - MIN_ELEVATION) + 1e-9);
			expect(b.minPolar).toBeGreaterThanOrEqual(Math.min(f.polar, POLAR_FLOOR) - 1e-9);
			expect(b.minPolar).toBeGreaterThan(0);
		}
		// A view near the plane or near straight down keeps the bounds inside the limits.
		const steep = rotationBounds(framingAt([0, 0, 0], 50, 10 * RAD, 0));
		expect(steep.minPolar).toBeCloseTo(POLAR_FLOOR, 9);
		const flat = rotationBounds(framingAt([0, 0, 0], 50, 70 * RAD, 0));
		expect(deg(flat.maxPolar)).toBeCloseTo(75, 9); // 15 degrees above the plane
	});

	it('keeps the framing\'s own view inside its bounds, even a bottom edge looking along the plane', () => {
		for (const f of [...views(), framingAt([0, 0, 0], 20, 80 * RAD, 1), framingAt([0, 0, 0], 20, 1 * RAD, 0)]) {
			const b = rotationBounds(f);
			expect(f.polar).toBeGreaterThanOrEqual(b.minPolar);
			expect(f.polar).toBeLessThanOrEqual(b.maxPolar);
			expect(f.azimuth).toBeGreaterThan(b.minAzimuth);
			expect(f.azimuth).toBeLessThan(b.maxAzimuth);
		}
	});

	it('lets a drag overshoot the soft bounds by a few degrees, and no more', () => {
		for (const f of views()) {
			const b = rotationBounds(f);
			const h = hardBounds(f);
			expect(h.minAzimuth).toBeLessThan(b.minAzimuth);
			expect(h.maxAzimuth).toBeGreaterThan(b.maxAzimuth);
			expect(b.minAzimuth - h.minAzimuth).toBeLessThanOrEqual(3 * RAD); // a small slack
			expect(h.maxPolar - b.maxPolar).toBeLessThanOrEqual(3 * RAD);
			expect(h.maxPolar).toBeGreaterThanOrEqual(b.maxPolar);
			expect(h.maxPolar).toBeLessThan(90 * RAD); // never to the plane itself
			expect(h.minPolar).toBeGreaterThan(0); // never exactly straight down
		}
	});

	describe('easeToBounds', () => {
		const home = framingAt([1, 2, 3], 40, 0.6, 0.3);
		const b = rotationBounds(home);

		it('is null inside the bounds, at the edge, and for a view a hair past it', () => {
			expect(easeToBounds(home, b, 0.5)).toBeNull();
			expect(easeToBounds(framingAt(home.target, 40, b.maxPolar, b.maxAzimuth), b, 0.5)).toBeNull();
			expect(easeToBounds(framingAt(home.target, 40, b.maxPolar + 0.0001, b.maxAzimuth + 0.0001), b, 0.5)).toBeNull();
		});

		it('eases a view back by a fraction of the way, keeping the target and the distance', () => {
			const past = framingAt(home.target, 40, b.maxPolar + 0.1, b.maxAzimuth + 0.2);
			const half = easeToBounds(past, b, 0.5)!;
			expect(half.polar).toBeCloseTo(b.maxPolar + 0.05, 9);
			expect(half.azimuth).toBeCloseTo(b.maxAzimuth + 0.1, 9);
			expect(half.target).toEqual(home.target);
			expect(half.distance).toBe(40);
			const all = easeToBounds(past, b, 1)!;
			expect(all.polar).toBeCloseTo(b.maxPolar, 9);
			expect(all.azimuth).toBeCloseTo(b.maxAzimuth, 9);
		});

		it('converges without overshooting or jitter: the distance to the bound only ever shrinks', () => {
			let v: ReturnType<typeof framingAt> | null = framingAt(home.target, 40, b.minPolar - 0.08, b.minAzimuth - 0.1);
			let last = Infinity;
			let steps = 0;
			while (v && steps < 200) {
				const gap = Math.abs(v.polar - b.minPolar) + Math.abs(v.azimuth - b.minAzimuth);
				expect(gap).toBeLessThan(last);
				expect(v.polar).toBeLessThanOrEqual(b.minPolar + 1e-9); // never crosses the bound
				last = gap;
				v = easeToBounds(v, b, easeFraction(16));
				steps++;
			}
			expect(v).toBeNull(); // it settled
			expect(steps).toBeLessThan(120); // in about a second or less
		});

		it('takes the short way across the +-pi seam for a view that looks from behind', () => {
			const behind = framingAt([0, 0, 0], 20, 1, 179 * RAD);
			const bb = rotationBounds(behind);
			// 20 degrees past the +10 bound, as the camera reports it (azimuth wrapped into -pi..pi, here about -126)
			const raw = framingAt([0, 0, 0], 20, 1, behind.azimuth + AZIMUTH_RANGE + 20 * RAD);
			const past = framingFromCamera(raw.position, raw.target);
			expect(past.azimuth).toBeLessThan(0);
			const next = easeToBounds(past, bb, 1)!;
			expect(Math.abs(Math.sin(next.azimuth - (behind.azimuth + AZIMUTH_RANGE)))).toBeLessThan(1e-6);
			expect(Math.cos(next.azimuth - (behind.azimuth + AZIMUTH_RANGE))).toBeGreaterThan(0.999);
		});

		it('eases only the angle that is out: a view past the azimuth bound keeps its tilt', () => {
			const tilted = framingAt(home.target, 40, home.polar + 0.1, b.maxAzimuth + 0.2);
			const out = easeToBounds(tilted, b, 1)!;
			expect(out.polar).toBeCloseTo(tilted.polar, 9);
			expect(out.azimuth).toBeCloseTo(b.maxAzimuth, 9);
		});
	});

	describe('boundsContaining', () => {
		const home = framingAt([0, 0, 0], 40, 0.6, 0.3);
		const b = hardBounds(home);

		it('is the bounds themselves for a view inside them', () => {
			const w = boundsContaining(b, home);
			for (const k of ['minAzimuth', 'maxAzimuth', 'minPolar', 'maxPolar'] as const) expect(w[k]).toBeCloseTo(b[k], 9);
		});

		it('widens the bounds to hold a view far outside them, so grabbing the camera mid-move cannot make it jump', () => {
			const far = framingAt([0, 0, 0], 40, 1.2, 0.3 + 50 * RAD); // a mid-move view 50 degrees round and 35 degrees down from home
			const w = boundsContaining(b, far);
			expect(w.maxAzimuth).toBeGreaterThanOrEqual(far.azimuth);
			expect(w.maxPolar).toBeGreaterThanOrEqual(far.polar);
			expect(w.minAzimuth).toBeCloseTo(b.minAzimuth, 9); // the other sides stay put
			expect(w.minPolar).toBeCloseTo(b.minPolar, 9);
			// every azimuth and polar from the view back to home lies inside the window: nothing clamps on the way in
			const toward = easeToBounds(far, rotationBounds(home), 0.5)!;
			expect(toward.azimuth).toBeLessThan(far.azimuth);
			expect(toward.azimuth).toBeGreaterThan(rotationBounds(home).maxAzimuth);
			expect(toward.azimuth).toBeLessThanOrEqual(w.maxAzimuth);
		});

		it('takes the short way round the seam for a view from behind', () => {
			const behind = framingAt([0, 0, 0], 20, 1, 179 * RAD);
			const raw = framingAt([0, 0, 0], 20, 1, behind.azimuth - 40 * RAD);
			const view = framingFromCamera(raw.position, raw.target);
			const w = boundsContaining(hardBounds(behind), view);
			expect(w.maxAzimuth - w.minAzimuth).toBeLessThan(Math.PI);
			expect(w.minAzimuth).toBeLessThan(behind.azimuth - 40 * RAD + 1e-6);
		});
	});

	it('easeFraction is the same feel at any frame rate, instant under reduced motion, and bounded', () => {
		expect(easeFraction(0)).toBe(0);
		expect(easeFraction(16, true)).toBe(1);
		expect(easeFraction(16)).toBeGreaterThan(0);
		expect(easeFraction(16)).toBeLessThan(0.3);
		// two 8 ms steps cover the same ground as one 16 ms step
		const two = 1 - (1 - easeFraction(8)) ** 2;
		expect(two).toBeCloseTo(easeFraction(16), 9);
		expect(easeFraction(5000)).toBeLessThan(1); // a stalled frame does not snap
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
