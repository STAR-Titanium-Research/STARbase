// The height grid of a surface scan: what /meta and /grid hand over, checked and made ready for the GPU.
// Contract (spec, "Derived data"): grid.bin is float32 little-endian, row-major, top row first, micrometres,
// NaN = no data; meta.json describes it. Pure: no Vue, no three.js, so it runs in Node tests.

export class ScanDataError extends Error {}

export interface ScanMeta {
	width: number;
	height: number;
	pixelPitchXUm: number | null;
	pixelPitchYUm: number | null;
	zMinUm: number | null;
	zMaxUm: number | null;
	sourceWidth: number | null;
	sourceHeight: number | null;
	sourceFormat: string | null;
}

// The decimated grid is at most 1024 cells on the longer side; a meta that claims much more is not ours.
export const MAX_GRID_SIDE = 4096;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** meta.json, checked. The grid size must be sane; every other number may be missing. */
export function parseMeta(raw: unknown): ScanMeta {
	if (typeof raw !== 'object' || raw === null) throw new ScanDataError('The scan description is not readable.');
	const m = raw as Record<string, unknown>;
	const width = count(m.width);
	const height = count(m.height);
	if (!width || !height) throw new ScanDataError('The scan description has no grid size.');
	if (width > MAX_GRID_SIDE || height > MAX_GRID_SIDE) throw new ScanDataError(`The scan grid is too large (${width} x ${height}).`);
	if (width < 2 || height < 2) throw new ScanDataError('The scan grid is too small to draw.');
	const pitch = (v: unknown) => {
		const n = finite(v);
		return n !== null && n > 0 ? n : null;
	};
	return {
		width,
		height,
		pixelPitchXUm: pitch(m.pixel_pitch_x_um),
		pixelPitchYUm: pitch(m.pixel_pitch_y_um),
		zMinUm: finite(m.z_min_um),
		zMaxUm: finite(m.z_max_um),
		sourceWidth: count(m.source_width),
		sourceHeight: count(m.source_height),
		sourceFormat: typeof m.source_format === 'string' && m.source_format ? m.source_format : null,
	};
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** grid.bin as floats. A file whose length does not match the meta is refused: drawing it would shear the surface. */
export function decodeGrid(buffer: ArrayBuffer, meta: ScanMeta): Float32Array {
	const cells = meta.width * meta.height;
	if (buffer.byteLength !== cells * 4) {
		throw new ScanDataError(`The grid has ${buffer.byteLength} bytes; ${meta.width} x ${meta.height} cells need ${cells * 4}.`);
	}
	if (LITTLE_ENDIAN) return new Float32Array(buffer.slice(0));
	const out = new Float32Array(cells);
	const view = new DataView(buffer);
	for (let i = 0; i < cells; i++) out[i] = view.getFloat32(i * 4, true);
	return out;
}

export interface GridStats {
	min: number;
	max: number;
	valid: number;
	missing: number;
}

/** The height range of the cells that hold data. With none, min and max are 0. */
export function gridStats(grid: Float32Array): GridStats {
	let min = Infinity;
	let max = -Infinity;
	let valid = 0;
	for (let i = 0; i < grid.length; i++) {
		const v = grid[i];
		if (!Number.isFinite(v)) continue;
		valid++;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return valid === 0 ? { min: 0, max: 0, valid: 0, missing: grid.length } : { min, max, valid, missing: grid.length - valid };
}

export interface TextureData {
	/** width x height x 2: [height, 1] for a cell with data, [filled height, 0] for a missing one. */
	data: Float32Array;
	stats: GridStats;
}

const FILL_PASSES = 512;

/**
 * The grid in the form the shader reads. A GPU may treat NaN as anything, so none is ever uploaded: a missing
 * cell gets a height filled in from its neighbours (so the surface next to a hole is not dragged down to 0) and a
 * second channel set to 0, and the fragment shader discards where that channel says "no data".
 */
export function buildTextureData(grid: Float32Array, width: number, height: number): TextureData {
	if (grid.length !== width * height) throw new ScanDataError('The grid does not match its size.');
	const stats = gridStats(grid);
	const data = new Float32Array(grid.length * 2);
	const known = new Uint8Array(grid.length); // 1 = has a height (valid, or already filled)
	const open: number[] = [];
	for (let i = 0; i < grid.length; i++) {
		if (Number.isFinite(grid[i])) {
			data[i * 2] = grid[i];
			data[i * 2 + 1] = 1;
			known[i] = 1;
		} else {
			open.push(i);
		}
	}
	if (open.length === 0) return { data, stats };

	// Grow the known cells into the holes one ring at a time, each new cell the mean of its known 4-neighbours.
	const fallback = stats.valid ? (stats.min + stats.max) / 2 : 0;
	let todo = open;
	for (let pass = 0; pass < FILL_PASSES && todo.length > 0; pass++) {
		const filled: Array<[number, number]> = [];
		const left: number[] = [];
		for (const i of todo) {
			const x = i % width;
			const y = (i - x) / width;
			let sum = 0;
			let n = 0;
			if (x > 0 && known[i - 1]) { sum += data[(i - 1) * 2]; n++; }
			if (x < width - 1 && known[i + 1]) { sum += data[(i + 1) * 2]; n++; }
			if (y > 0 && known[i - width]) { sum += data[(i - width) * 2]; n++; }
			if (y < height - 1 && known[i + width]) { sum += data[(i + width) * 2]; n++; }
			if (n > 0) filled.push([i, sum / n]);
			else left.push(i);
		}
		if (filled.length === 0) break; // no known cell at all: the fallback below
		for (const [i, v] of filled) {
			data[i * 2] = v;
			known[i] = 1;
		}
		todo = left;
	}
	for (const i of todo) data[i * 2] = fallback; // a hole too deep to grow into, or a grid with no data
	return { data, stats };
}
