import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createMapProjector } from './mapProjector';

const W = 640, H = 480;

// What the views did before: Vector3.project, then NDC -> CSS px.
function reference(camera: THREE.Camera, model: THREE.Matrix4 | null, x: number, y: number, z: number) {
	const v = new THREE.Vector3(x, y, z);
	if (model) v.applyMatrix4(model);
	v.project(camera);
	if (!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1)) return null;
	return { px: (v.x + 1) / 2 * W, py: (1 - v.y) / 2 * H };
}

function ortho(): THREE.OrthographicCamera {
	const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 1e6);
	cam.position.set(3, -2, 10);
	cam.updateProjectionMatrix(); cam.updateMatrixWorld();
	return cam;
}
function persp(): THREE.PerspectiveCamera {
	const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 1e6);
	cam.position.set(10, -30, 40); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0);
	cam.updateProjectionMatrix(); cam.updateMatrixWorld();
	return cam;
}

const pts: [number, number, number][] = [];
for (let i = 0; i < 200; i++) pts.push([Math.sin(i * 1.3) * 45, Math.cos(i * 0.7) * 40, Math.sin(i * 0.31) * 8]);

describe('createMapProjector.project', () => {
	for (const [name, mk] of [['orthographic', ortho], ['perspective', persp]] as const) {
		for (const withModel of [false, true]) {
			it(`matches Vector3.project, ${name}${withModel ? ' with a model matrix' : ''}`, () => {
				const cam = mk();
				const model = withModel ? new THREE.Matrix4().makeScale(1, 1, 0.35).setPosition(1, 2, 0.5) : null;
				const p = createMapProjector();
				p.setup(cam, model, W, H);
				let inside = 0;
				for (const [x, y, z] of pts) {
					const ref = reference(cam, model, x, y, z), got = p.project(x, y, z);
					if (!ref) { expect(got).toBeNull(); continue; }
					inside++;
					expect(got).not.toBeNull();
					expect(got!.px).toBeCloseTo(ref.px, 6);
					expect(got!.py).toBeCloseTo(ref.py, 6);
				}
				expect(inside).toBeGreaterThan(8);   // the test is not vacuous
			});
		}
	}
	it('returns null for NaN and for a point behind a perspective camera', () => {
		const p = createMapProjector();
		p.setup(persp(), null, W, H);
		expect(p.project(NaN, 0, 0)).toBeNull();
		expect(p.project(10, -30, 200)).toBeNull();   // behind the eye (camera looks toward the origin)
	});
	it('reuses one result object', () => {
		const p = createMapProjector();
		p.setup(ortho(), null, W, H);
		expect(p.project(3, -2, 0)).toBe(p.project(4, -2, 0));
	});
});

describe('createMapProjector.discAt', () => {
	it('inverts project on the plane and bounds the pixel radius (ortho, zoomed and panned)', () => {
		const cam = ortho(); cam.zoom = 3; cam.updateProjectionMatrix();
		const p = createMapProjector();
		p.setup(cam, null, W, H);
		const target = p.project(5, 1, 0)!;
		const tx = target.px, ty = target.py;
		const d = p.discAt(tx, ty, 8)!;
		expect(d.x).toBeCloseTo(5, 6);
		expect(d.y).toBeCloseTo(1, 6);
		// a point 8 px away is inside the world radius
		const edge = p.project(5 + d.r, 1, 0)!;
		expect(Math.hypot(edge.px - tx, edge.py - ty)).toBeGreaterThanOrEqual(8);
		const near = p.project(d.x + 0.99 * d.r / 1.001 * 0.5, d.y, 0)!;
		expect(Math.hypot(near.px - tx, near.py - ty)).toBeLessThan(8);
	});
	it('holds for a rotated, anisotropic ortho view', () => {
		const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 1e6);
		cam.position.set(0, 0, 10); cam.up.set(1, 1, 0); cam.lookAt(0, 0, 0);
		cam.scale.set(1, 1, 1);
		cam.updateProjectionMatrix(); cam.updateMatrixWorld();
		const p = createMapProjector();
		p.setup(cam, null, W, H);
		const c = p.project(2, 1, 0)!;
		const cpx = c.px, cpy = c.py;
		const d = p.discAt(cpx, cpy, 10)!;
		// any sample within 10 px of the click lies within d.r of its world point
		for (let i = 0; i < 360; i += 5) {
			const wx = 2 + Math.cos(i) * 3, wy = 1 + Math.sin(i) * 3;
			const s = p.project(wx, wy, 0);
			if (s && Math.hypot(s.px - cpx, s.py - cpy) <= 10) expect(Math.hypot(wx - d.x, wy - d.y)).toBeLessThanOrEqual(d.r);
		}
	});
	it('is null for a perspective camera', () => {
		const p = createMapProjector();
		p.setup(persp(), null, W, H);
		expect(p.discAt(100, 100, 8)).toBeNull();
	});
});
