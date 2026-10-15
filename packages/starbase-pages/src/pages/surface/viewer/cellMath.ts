// The placement maths of the vertex shader (surfaceShaders.ts), written out in TypeScript so its orientation can be
// unit-tested: a flipped or mirrored surface would still draw, still be lit and still pass every test that only counts
// pixels. Keep the two in step: surfaceShaders.test.ts also pins the shader's key expressions.
//
// Conventions (spec, "Derived data"): grid.bin is row-major with the TOP row first and x growing to the right. The
// plane's uv is PlaneGeometry's (u = 0 at the left, v = 1 at the top). In the scene x grows with the column, y is
// height, and z grows with the row, so the top row of the file is the FAR edge as the camera first looks at it.

export interface GridCell {
	col: number;
	row: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** `cellOf` of the shader: the grid cell a plane vertex (or fragment) with this uv sits on. */
export function cellOf(u: number, v: number, cols: number, rows: number): GridCell {
	return {
		col: clamp(Math.floor(u * (cols - 1) + 0.5), 0, cols - 1),
		row: clamp(Math.floor((1 - v) * (rows - 1) + 0.5), 0, rows - 1),
	};
}

export interface PlacementParams {
	/** Plane size in scene units (ScanLayout.sizeX, sizeZ). */
	sizeX: number;
	sizeZ: number;
	/** Scene units per micrometre. */
	umToScene: number;
	exaggeration: number;
	/** Height (micrometres) the surface is centred on. */
	zMidUm: number;
}

/** Where the vertex with this uv and height (micrometres) goes in the scene: x right, y up, z towards the viewer. */
export function vertexPosition(u: number, v: number, heightUm: number, p: PlacementParams): [number, number, number] {
	return [(u - 0.5) * p.sizeX, (heightUm - p.zMidUm) * p.exaggeration * p.umToScene, (0.5 - v) * p.sizeZ];
}

/**
 * The surface normal the vertex shader computes at a cell, from its four neighbours (clamped at the border).
 * `heights` is row-major, top row first, in micrometres; the pitch is micrometres between cells.
 */
export function surfaceNormal(
	heights: ArrayLike<number>, cols: number, rows: number, cell: GridCell, pitchXUm: number, pitchZUm: number, exaggeration: number,
): [number, number, number] {
	const at = (c: number, r: number) => heights[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)];
	const dhdx = (at(cell.col + 1, cell.row) - at(cell.col - 1, cell.row)) / (2 * pitchXUm);
	const dhdz = (at(cell.col, cell.row + 1) - at(cell.col, cell.row - 1)) / (2 * pitchZUm);
	const nx = -dhdx * exaggeration;
	const nz = -dhdz * exaggeration;
	const len = Math.hypot(nx, 1, nz);
	return [nx / len, 1 / len, nz / len];
}
