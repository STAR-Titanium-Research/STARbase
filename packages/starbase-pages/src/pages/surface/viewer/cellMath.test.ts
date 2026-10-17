import { describe, expect, it } from 'vitest';
import { PlaneGeometry } from 'three';
import { cellOf, surfaceNormal, vertexPosition, type PlacementParams } from './cellMath';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './surfaceShaders';

// A 3 x 2 grid, top row first, x to the right. Heights are distinct, so every cell is recognisable:
//        col 0  col 1  col 2
// row 0 (top)  1      2      3
// row 1        4      5      6
const COLS = 3;
const ROWS = 2;
const HEIGHTS = [1, 2, 3, 4, 5, 6];
const P: PlacementParams = { sizeX: 1, sizeZ: 0.5, umToScene: 0.01, exaggeration: 2, zMidUm: 3.5 };

// The vertices of the plane the scene really builds, with the uv three.js really gives them.
function planeVertices() {
	const g = new PlaneGeometry(1, 1, COLS - 1, ROWS - 1);
	const uv = g.getAttribute('uv');
	const pos = g.getAttribute('position');
	const out = [];
	for (let i = 0; i < uv.count; i++) out.push({ u: uv.getX(i), v: uv.getY(i), px: pos.getX(i), py: pos.getY(i) });
	g.dispose();
	return out;
}

describe('cellOf', () => {
	it('puts the top-left vertex of the plane on the first cell of the file (top row, left column)', () => {
		const tl = planeVertices().find((v) => v.px < 0 && v.py > 0)!;
		expect(cellOf(tl.u, tl.v, COLS, ROWS)).toEqual({ col: 0, row: 0 });
		expect(HEIGHTS[0]).toBe(1);
	});
	it('puts the bottom-right vertex on the last cell, and each corner on its own', () => {
		const at = (sx: number, sy: number) => {
			const v = planeVertices().find((q) => Math.sign(q.px) === sx && Math.sign(q.py) === sy)!;
			const c = cellOf(v.u, v.v, COLS, ROWS);
			return HEIGHTS[c.row * COLS + c.col];
		};
		expect([at(-1, 1), at(1, 1), at(-1, -1), at(1, -1)]).toEqual([1, 3, 4, 6]); // TL, TR, BL, BR
		expect(at(0, 1)).toBe(2); // the middle of the top edge
	});
	it('maps every plane vertex to a distinct cell, none mirrored (rows and columns both ordered)', () => {
		const seen = new Set<string>();
		for (const v of planeVertices()) {
			const c = cellOf(v.u, v.v, COLS, ROWS);
			seen.add(`${c.col},${c.row}`);
			expect(c.col).toBe(Math.round((v.px + 0.5) * (COLS - 1))); // left to right
			expect(c.row).toBe(Math.round((0.5 - v.py) * (ROWS - 1))); // top to bottom
		}
		expect(seen.size).toBe(COLS * ROWS);
	});
	it('clamps what is outside the grid', () => {
		expect(cellOf(-0.2, 1.3, COLS, ROWS)).toEqual({ col: 0, row: 0 });
		expect(cellOf(1.4, -0.4, COLS, ROWS)).toEqual({ col: COLS - 1, row: ROWS - 1 });
	});
});

describe('vertexPosition', () => {
	it('puts the first row at the far edge (negative z) and the last row near (positive z)', () => {
		const top = planeVertices().find((v) => v.px < 0 && v.py > 0)!;
		const bottom = planeVertices().find((v) => v.px > 0 && v.py < 0)!;
		const [x0, , z0] = vertexPosition(top.u, top.v, 1, P);
		const [x1, , z1] = vertexPosition(bottom.u, bottom.v, 6, P);
		expect(x0).toBeCloseTo(-0.5);
		expect(z0).toBeCloseTo(-0.25);
		expect(x1).toBeCloseTo(0.5);
		expect(z1).toBeCloseTo(0.25);
	});
	it('raises higher cells and centres the surface on the middle height, scaled by the exaggeration', () => {
		expect(vertexPosition(0.5, 0.5, 3.5, P)[1]).toBe(0);
		expect(vertexPosition(0.5, 0.5, 5.5, P)[1]).toBeCloseTo(2 * 2 * 0.01);
		expect(vertexPosition(0.5, 0.5, 1.5, P)[1]).toBeLessThan(0);
	});
});

describe('surfaceNormal', () => {
	it('leans away from the rise: a surface climbing to the right has its normal tilted to the left (-x)', () => {
		const climbing = [0, 1, 2, 0, 1, 2];
		const n = surfaceNormal(climbing, COLS, ROWS, { col: 1, row: 0 }, 1, 1, 1);
		expect(n[0]).toBeLessThan(-0.5);
		expect(n[2]).toBeCloseTo(0);
		expect(n[1]).toBeGreaterThan(0);
	});
	it('a surface climbing towards the near edge (down the rows) leans away, to -z', () => {
		const n = surfaceNormal([0, 0, 0, 1, 1, 1], COLS, ROWS, { col: 1, row: 0 }, 1, 1, 1);
		expect(n[2]).toBeLessThan(-0.4); // at the border the slope is read over one cell, not two
		expect(n[0]).toBeCloseTo(0);
	});
	it('is straight up on a flat surface, is a unit vector, and exaggeration steepens it', () => {
		const flat = surfaceNormal([5, 5, 5, 5, 5, 5], COLS, ROWS, { col: 1, row: 1 }, 1, 1, 1);
		expect(flat[0]).toBeCloseTo(0);
		expect(flat[1]).toBeCloseTo(1);
		expect(flat[2]).toBeCloseTo(0);
		const a = surfaceNormal([0, 1, 2, 0, 1, 2], COLS, ROWS, { col: 1, row: 0 }, 4, 4, 1);
		const b = surfaceNormal([0, 1, 2, 0, 1, 2], COLS, ROWS, { col: 1, row: 0 }, 4, 4, 20);
		expect(Math.hypot(...a)).toBeCloseTo(1);
		expect(Math.abs(b[0])).toBeGreaterThan(Math.abs(a[0]));
	});
});

describe('the shader says the same', () => {
	it('uses these expressions for the cell, the position and the slopes', () => {
		for (const src of [VERTEX_SHADER, FRAGMENT_SHADER]) {
			expect(src).toContain('floor(uv.x * (uCells.x - 1.0) + 0.5)');
			expect(src).toContain('floor((1.0 - uv.y) * (uCells.y - 1.0) + 0.5)');
		}
		expect(VERTEX_SHADER).toContain('(uv.x - 0.5) * uScene.x');
		expect(VERTEX_SHADER).toContain('(h - uZMid) * uExag * uScene.z');
		expect(VERTEX_SHADER).toContain('(0.5 - uv.y) * uScene.y');
		expect(VERTEX_SHADER).toContain('(heightAt(c + ivec2(1, 0)) - heightAt(c - ivec2(1, 0))) / (2.0 * uPitch.x)');
		expect(VERTEX_SHADER).toContain('(heightAt(c + ivec2(0, 1)) - heightAt(c - ivec2(0, 1))) / (2.0 * uPitch.y)');
		expect(VERTEX_SHADER).toContain('vec3(-dhdx * uExag, 1.0, -dhdz * uExag)');
	});
});
