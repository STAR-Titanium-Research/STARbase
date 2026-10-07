// World (mm) -> canvas px for the map views' picks and rings, without THREE's per-point
// Vector3.project (which copies, multiplies by the view matrix, then by the projection matrix, with a
// divide each time). A right-click pick projects up to ~3M samples, so the two matrices (and the
// cloud's model matrix, when it has one) are folded into ONE 4x4 per pick and each sample costs
// three dot products and a divide, written into a reused result object.
import * as THREE from 'three';

export interface ScreenPoint { px: number; py: number }

/** A world point and radius (mm) that bound everything within `radiusPx` of a screen spot, on one flat plane. */
export interface WorldDisc { x: number; y: number; r: number }

export function createMapProjector() {
	const m = new THREE.Matrix4();
	const out: ScreenPoint = { px: 0, py: 0 };
	// the rows project() needs, copied out of the matrix: x, y and w of the clip position (z is not
	// tested -- the views never clip on depth)
	let a0 = 0, a1 = 0, a2 = 0, a3 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, w0 = 0, w1 = 0, w2 = 0, w3 = 1;
	let halfW = 0, halfH = 0;
	const disc: WorldDisc = { x: 0, y: 0, r: 0 };

	return {
		/**
		 * Fold projection * view [* model] for this camera and canvas size (CSS px). Call after the
		 * camera's matrices are current (updateMatrixWorld / updateProjectionMatrix), once per pick or
		 * per ring update; `model` is the cloud's matrixWorld, or null when positions are already world.
		 */
		setup(camera: THREE.Camera, model: THREE.Matrix4 | null, cssW: number, cssH: number): void {
			m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
			if (model) m.multiply(model);
			const e = m.elements;   // column-major: element (row, col) is e[row + col * 4]
			a0 = e[0]; a1 = e[4]; a2 = e[8]; a3 = e[12];
			b0 = e[1]; b1 = e[5]; b2 = e[9]; b3 = e[13];
			w0 = e[3]; w1 = e[7]; w2 = e[11]; w3 = e[15];
			halfW = cssW / 2; halfH = cssH / 2;
		},

		/**
		 * The canvas px of world point (x, y, z), or null when it is off the clip volume horizontally
		 * or vertically, behind a perspective camera, or NaN. The result is a shared object: use it
		 * before the next call.
		 */
		project(x: number, y: number, z: number): ScreenPoint | null {
			const w = w0 * x + w1 * y + w2 * z + w3;
			if (!(w > 0)) return null;
			const nx = (a0 * x + a1 * y + a2 * z + a3) / w;
			const ny = (b0 * x + b1 * y + b2 * z + b3) / w;
			if (!(Math.abs(nx) <= 1 && Math.abs(ny) <= 1)) return null;
			out.px = (nx + 1) * halfW; out.py = (1 - ny) * halfH;
			return out;
		},

		/**
		 * For an orthographic view of the plane z = 0: the world point under canvas (px, py) and a
		 * world radius that covers every point of that plane projecting within `radiusPx` of it. The
		 * radius is exact up to a hair of slack (the smallest px-per-mm of the view's 2x2, so it also
		 * holds for a rotated or anisotropic ortho view), which is what lets a pick skip a sample on
		 * its distance from the click instead of projecting it. null for a perspective view (where
		 * pixels aren't a fixed number of mm) or a degenerate one. The result is a shared object.
		 */
		discAt(px: number, py: number, radiusPx: number): WorldDisc | null {
			if (w0 !== 0 || w1 !== 0 || w2 !== 0 || !(w3 > 0)) return null;
			// px = halfW * (clipX / w3 + 1), py = halfH * (1 - clipY / w3): scale the rows to px per mm
			const sx = halfW / w3, sy = halfH / w3;
			const j00 = a0 * sx, j01 = a1 * sx, j10 = -b0 * sy, j11 = -b1 * sy;
			const det = j00 * j11 - j01 * j10;
			if (!(Math.abs(det) > 1e-12)) return null;
			const rx = px - halfW - a3 * sx;   // the plane z = 0: the flat views the cull is for
			const ry = py - halfH + b3 * sy;
			disc.x = (rx * j11 - j01 * ry) / det;
			disc.y = (j00 * ry - j10 * rx) / det;
			// smallest singular value of the 2x2: |d px| >= sigmaMin * |d world|
			const s = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11;
			const sigmaMin = Math.sqrt(Math.max(0, (s - Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2));
			if (!(sigmaMin > 0)) return null;
			disc.r = radiusPx / sigmaMin * 1.001 + 1e-9;
			return disc;
		},
	};
}
