import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { buildToolingModel } from '@d1/ui';
import {
	AZIMUTH_RANGE, easeInOutCubic, easeStep, frameBox, frameEdge, frameInsert, FramingTween, framingAt, framingFromCamera,
	boundsContaining, framingsClose, hardBounds, interpolateFraming, MAX_OVERSHOOT, MIN_ELEVATION, RECENTRE_DELAY_MS, rubberBand,
	rubberBandInverse, rubberStep, rubberView, SPRING_OMEGA, SPRING_ZETA, springStep, springToBounds, moveDuration, MOVE_MS, orbitLimits, POLAR_FLOOR, POLAR_MAX, POLAR_MIN,
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
		expect(MAX_OVERSHOOT).toBeCloseTo(6 * RAD, 9);
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

	it('lets a drag overshoot the soft bounds by about 6 degrees at most (the hard limits), and no more', () => {
		for (const f of views()) {
			const b = rotationBounds(f);
			const h = hardBounds(f);
			expect(h.minAzimuth).toBeLessThan(b.minAzimuth);
			expect(h.maxAzimuth).toBeGreaterThan(b.maxAzimuth);
			expect(b.minAzimuth - h.minAzimuth).toBeCloseTo(MAX_OVERSHOOT, 9);
			expect(h.maxAzimuth - b.maxAzimuth).toBeCloseTo(MAX_OVERSHOOT, 9);
			expect(h.maxPolar - b.maxPolar).toBeLessThanOrEqual(MAX_OVERSHOOT + 1e-9);
			expect(h.maxPolar).toBeGreaterThanOrEqual(b.maxPolar);
			expect(h.maxPolar).toBeLessThan(90 * RAD); // never to the plane itself
			expect(h.minPolar).toBeGreaterThan(0); // never exactly straight down
		}
	});

	describe('rubber band', () => {
		it('is one to one at first, then resists, and never passes the maximum overshoot', () => {
			expect(rubberBand(0)).toBe(0);
			expect(rubberBand(0.001)).toBeCloseTo(0.001, 4);
			let last = 0;
			let lastGain = 1;
			for (let x = 0.01; x < 2; x += 0.01) {
				const y = rubberBand(x);
				expect(y).toBeGreaterThan(last); // always moves on
				expect(y).toBeLessThan(MAX_OVERSHOOT); // never reaches the maximum
				const gain = (y - last) / 0.01;
				expect(gain).toBeLessThanOrEqual(lastGain + 1e-9); // less and less per unit of drag
				last = y;
				lastGain = gain;
			}
			expect(rubberBand(10)).toBeCloseTo(MAX_OVERSHOOT, 3); // a huge drag approaches it
			expect(rubberBand(-0.3)).toBe(-0.3); // inside a bound it is free
		});

		it('has an inverse', () => {
			for (const x of [0, 0.01, 0.05, 0.1, 0.3]) expect(rubberBandInverse(rubberBand(x))).toBeCloseTo(x, 9);
			expect(Number.isFinite(rubberBandInverse(MAX_OVERSHOOT))).toBe(true); // a view at the maximum does not blow up
		});

		it('damps each step by how far past the bound the view already is', () => {
			const d = 0.01;
			const early = rubberStep(0, d); // just at the bound
			const mid = rubberStep(0.05, d) - 0.05;
			const late = rubberStep(0.09, d) - 0.09;
			expect(early).toBeCloseTo(d, 3);
			expect(mid).toBeLessThan(early);
			expect(late).toBeLessThan(mid);
			expect(late).toBeGreaterThan(0);
			// Many small steps add up to one big drag.
			let e = 0;
			for (let i = 0; i < 100; i++) e = rubberStep(e, 0.005);
			expect(e).toBeCloseTo(rubberBand(0.5), 9);
			expect(e).toBeLessThan(MAX_OVERSHOOT);
		});

		it('is free inside the bound, and crossing it from inside is resisted only for the part past it', () => {
			expect(rubberStep(-0.1, 0.03)).toBeCloseTo(-0.07, 9);
			expect(rubberStep(-0.02, 0.05)).toBeCloseTo(rubberBand(0.03), 9);
		});

		it('lets the view come back as freely as it went: pulling back past a bound retraces the band', () => {
			let e = rubberStep(0, 0.4);
			expect(e).toBeGreaterThan(0.05);
			e = rubberStep(e, -0.4);
			expect(e).toBeCloseTo(0, 9);
			expect(rubberStep(0.05, -0.2)).toBeCloseTo(rubberBand(rubberBandInverse(0.05) - 0.2), 9);
		});

		const home = framingAt([1, 2, 3], 40, 0.6, 0.3);
		const b = rotationBounds(home);

		it('leaves a step that stays inside the bounds alone', () => {
			const next = framingAt(home.target, 40, home.polar + 0.01, home.azimuth - 0.02);
			expect(rubberView(home, next, b)).toBeNull();
		});

		it('damps a step past the azimuth bound and keeps the tilt, the target and the distance', () => {
			const prev = framingAt(home.target, 40, home.polar, b.maxAzimuth + 0.03);
			const next = framingAt(home.target, 40, home.polar + 0.002, b.maxAzimuth + 0.08); // the drag asked for 0.05 more
			const v = rubberView(prev, next, b)!;
			expect(v.azimuth - prev.azimuth).toBeGreaterThan(0);
			expect(v.azimuth - prev.azimuth).toBeLessThan(0.05); // resisted
			expect(v.azimuth - b.maxAzimuth).toBeLessThan(MAX_OVERSHOOT);
			expect(v.polar).toBeCloseTo(home.polar + 0.002, 9); // untouched
			expect(v.distance).toBe(40);
			expect(v.target).toEqual(home.target);
		});

		it('damps a step past the polar bounds, above and below', () => {
			const hi = rubberView(framingAt(home.target, 40, b.maxPolar + 0.02, 0.3), framingAt(home.target, 40, b.maxPolar + 0.07, 0.3), b)!;
			expect(hi.polar - (b.maxPolar + 0.02)).toBeLessThan(0.05);
			expect(hi.polar - b.maxPolar).toBeLessThan(MAX_OVERSHOOT);
			const lo = rubberView(framingAt(home.target, 40, b.minPolar - 0.02, 0.3), framingAt(home.target, 40, b.minPolar - 0.07, 0.3), b)!;
			expect(b.minPolar - lo.polar).toBeGreaterThan(0.02);
			expect(b.minPolar - lo.polar).toBeLessThan(0.07);
			expect(lo.polar).toBeGreaterThan(0); // the floor rule: the bound itself is above straight down
		});

		it('never lets a long drag take the view more than the maximum overshoot past any bound', () => {
			let view = framingAt(home.target, 40, home.polar, home.azimuth);
			for (let i = 0; i < 300; i++) {
				const next = framingAt(home.target, 40, view.polar - 0.01, view.azimuth + 0.02); // drag up and round, a long way
				view = rubberView(view, next, b) ?? next;
			}
			expect(view.azimuth - b.maxAzimuth).toBeLessThan(MAX_OVERSHOOT);
			expect(view.azimuth - b.maxAzimuth).toBeGreaterThan(MAX_OVERSHOOT * 0.9); // it did get close
			expect(b.minPolar - view.polar).toBeLessThan(MAX_OVERSHOOT);
			expect(view.polar).toBeGreaterThan(0);
		});

		it('works across the +-pi seam for a view from behind', () => {
			const behind = framingAt([0, 0, 0], 20, 1, 179 * RAD);
			const bb = rotationBounds(behind);
			let view = framingFromCamera(behind.position, behind.target);
			for (let i = 0; i < 300; i++) {
				const raw = framingAt(view.target, 20, view.polar, view.azimuth + 0.02);
				const next = framingFromCamera(raw.position, raw.target); // the camera reports its azimuth wrapped
				view = rubberView(view, next, bb) ?? next;
			}
			const off = Math.atan2(Math.sin(view.azimuth - behind.azimuth), Math.cos(view.azimuth - behind.azimuth));
			expect(off).toBeGreaterThan(AZIMUTH_RANGE); // past the bound...
			expect(off - AZIMUTH_RANGE).toBeLessThan(MAX_OVERSHOOT); // ...by less than the maximum, and not flipped to the other side
		});
	});

	describe('the spring', () => {
		it('settles a displacement to zero in about 300 ms, from rest', () => {
			let st = { x: 0.1, v: 0 };
			for (let t = 0; t < 300; t += 16) st = springStep(st.x, st.v, 16);
			expect(Math.abs(st.x)).toBeLessThan(0.1 * 0.03); // within 3 % at 300 ms
			for (let t = 0; t < 400; t += 16) st = springStep(st.x, st.v, 16);
			expect(Math.abs(st.x)).toBeLessThan(0.1 * 0.003);
		});

		it('has no visible bounce: it never goes more than 1 % of the way past zero', () => {
			let st = { x: 0.1, v: 0 };
			let lowest = st.x;
			for (let t = 0; t < 1500; t += 4) {
				st = springStep(st.x, st.v, 4);
				lowest = Math.min(lowest, st.x);
			}
			expect(lowest).toBeGreaterThan(-0.1 * 0.01);
			expect(SPRING_ZETA).toBeLessThan(1); // slightly damped, not critically
			expect(SPRING_OMEGA).toBeGreaterThan(10);
		});

		it('is frame-rate independent: two half steps are one whole step', () => {
			const one = springStep(0.1, 0.4, 16);
			const half = springStep(0.1, 0.4, 8);
			const two = springStep(half.x, half.v, 8);
			expect(two.x).toBeCloseTo(one.x, 12);
			expect(two.v).toBeCloseTo(one.v, 12);
			// and 1 / 60 s of steps against 1 / 30 s
			let a = { x: 0.1, v: 0 };
			let b = { x: 0.1, v: 0 };
			for (let i = 0; i < 30; i++) a = springStep(a.x, a.v, 1000 / 60);
			for (let i = 0; i < 15; i++) b = springStep(b.x, b.v, 1000 / 30);
			expect(a.x).toBeCloseTo(b.x, 6);
		});

		it('stays put at rest, and a stalled frame does not leap', () => {
			expect(springStep(0, 0, 16)).toEqual({ x: 0, v: 0 });
			const long = springStep(0.1, 0, 5000);
			const capped = springStep(0.1, 0, 100);
			expect(long.x).toBeCloseTo(capped.x, 12);
		});

		const home = framingAt([1, 2, 3], 40, 0.6, 0.3);
		const b = rotationBounds(home);
		const still = { azimuth: 0, polar: 0 };

		it('is null for a view inside the bounds, on a bound, or a hair past it', () => {
			expect(springToBounds(home, b, still, 16)).toBeNull();
			expect(springToBounds(framingAt(home.target, 40, b.maxPolar, b.maxAzimuth), b, still, 16)).toBeNull();
			expect(springToBounds(framingAt(home.target, 40, b.maxPolar + 0.0001, b.maxAzimuth + 0.0001), b, still, 16)).toBeNull();
		});

		it('springs a view past the azimuth bound back to it, keeping the tilt, the target and the distance, and never overshooting visibly', () => {
			let view: ReturnType<typeof framingAt> | null = framingAt(home.target, 40, home.polar + 0.03, b.maxAzimuth + 0.1);
			let vel = { ...still };
			let steps = 0;
			let lowest = Infinity;
			while (view && steps < 200) {
				const gap = view.azimuth - b.maxAzimuth;
				lowest = Math.min(lowest, gap);
				expect(view.polar).toBeCloseTo(home.polar + 0.03, 9);
				expect(view.distance).toBe(40);
				expect(view.target).toEqual(home.target);
				const r = springToBounds(view, b, vel, 16);
				if (!r) break;
				expect(r.view.azimuth - b.maxAzimuth).toBeLessThan(gap + 1e-9 + 0.0001); // heads for the bound
				view = r.view;
				vel = r.vel;
				steps++;
			}
			expect(steps).toBeLessThan(45); // done in well under a second at 60 fps (about 300 ms: 19 frames)
			expect(steps).toBeGreaterThan(8); // and not instantly
			expect(lowest).toBeGreaterThan(-0.001); // it never crossed the bound by a visible amount
		});

		it('springs back from both polar bounds and from the lower azimuth bound', () => {
			for (const view of [
				framingAt(home.target, 40, b.maxPolar + 0.08, home.azimuth),
				framingAt(home.target, 40, b.minPolar - 0.08, home.azimuth),
				framingAt(home.target, 40, home.polar, b.minAzimuth - 0.08),
			]) {
				let v: ReturnType<typeof framingAt> | null = view;
				let vel = { ...still };
				for (let i = 0; i < 60 && v; i++) {
					const r = springToBounds(v, b, vel, 16);
					if (!r) { v = null; break; }
					v = r.view;
					vel = r.vel;
				}
				expect(v).toBeNull();
			}
		});

		it('lands on the bound at once under reduced motion', () => {
			const r = springToBounds(framingAt(home.target, 40, b.maxPolar + 0.1, b.maxAzimuth + 0.1), b, still, 16, true)!;
			expect(r.view.polar).toBeCloseTo(b.maxPolar, 9);
			expect(r.view.azimuth).toBeCloseTo(b.maxAzimuth, 9);
			expect(springToBounds(r.view, b, r.vel, 16, true)).toBeNull();
		});

		it('takes the short way across the +-pi seam for a view that looks from behind', () => {
			const behind = framingAt([0, 0, 0], 20, 1, 179 * RAD);
			const bb = rotationBounds(behind);
			// 20 degrees past the +10 bound, as the camera reports it (azimuth wrapped into -pi..pi, here about -161)
			const raw = framingAt([0, 0, 0], 20, 1, behind.azimuth + AZIMUTH_RANGE + 20 * RAD);
			const past = framingFromCamera(raw.position, raw.target);
			expect(past.azimuth).toBeLessThan(0);
			let v: ReturnType<typeof framingAt> | null = past;
			let vel = { ...still };
			let guard = 0;
			let last = past;
			while (v && guard++ < 100) {
				last = v;
				const r = springToBounds(v, bb, vel, 16);
				v = r ? r.view : null;
				vel = r ? r.vel : vel;
			}
			const off = Math.atan2(Math.sin(last.azimuth - behind.azimuth), Math.cos(last.azimuth - behind.azimuth));
			expect(off).toBeCloseTo(AZIMUTH_RANGE, 2); // on the bound it was past, not carried round the other way
		});

		it('eases only the angle that is out: a view past the azimuth bound keeps its tilt', () => {
			const tilted = framingAt(home.target, 40, home.polar + 0.1, b.maxAzimuth + 0.2);
			const out = springToBounds(tilted, b, still, 16)!;
			expect(out.view.polar).toBeCloseTo(tilted.polar, 9);
			expect(out.view.azimuth).toBeLessThan(tilted.azimuth);
		});
	});

	it('framingsClose tells a view that is already on its framing from one that is not', () => {
		const f = framingAt([1, 2, 3], 40, 0.6, 0.3);
		expect(framingsClose(f, framingAt([1, 2, 3], 40, 0.6, 0.3))).toBe(true);
		expect(framingsClose(f, framingAt([1.01, 2, 3], 40.01, 0.6005, 0.3005))).toBe(true);
		expect(framingsClose(f, framingAt([1, 2, 3], 44, 0.6, 0.3))).toBe(false); // zoomed
		expect(framingsClose(f, framingAt([4, 2, 3], 40, 0.6, 0.3))).toBe(false); // panned
		expect(framingsClose(f, framingAt([1, 2, 3], 40, 0.7, 0.3))).toBe(false); // tilted
		expect(framingsClose(f, framingAt([1, 2, 3], 40, 0.6, 0.5))).toBe(false); // turned
		expect(framingsClose(framingAt([0, 0, 0], 40, 0.6, Math.PI - 0.0001), framingAt([0, 0, 0], 40, 0.6, -Math.PI + 0.0001))).toBe(true); // the seam
		expect(RECENTRE_DELAY_MS).toBe(1500);
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
			const toward = springToBounds(far, rotationBounds(home), { azimuth: 0, polar: 0 }, 16)!;
			expect(toward.view.azimuth).toBeLessThan(far.azimuth);
			expect(toward.view.azimuth).toBeGreaterThan(rotationBounds(home).maxAzimuth);
			expect(toward.view.azimuth).toBeLessThanOrEqual(w.maxAzimuth);
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
