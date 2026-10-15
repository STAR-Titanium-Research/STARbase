import { describe, expect, it } from 'vitest';
import { buildTextureData, decodeGrid, gridStats, parseMeta, ScanDataError } from './gridData';

const META = { width: 4, height: 3, pixel_pitch_x_um: 5, pixel_pitch_y_um: 5.5, z_min_um: -2, z_max_um: 8, source_width: 40, source_height: 30, source_format: 'al3d' };

describe('parseMeta', () => {
	it('reads the spec layout', () => {
		expect(parseMeta(META)).toEqual({
			width: 4, height: 3, pixelPitchXUm: 5, pixelPitchYUm: 5.5, zMinUm: -2, zMaxUm: 8, sourceWidth: 40, sourceHeight: 30, sourceFormat: 'al3d',
		});
	});
	it('lets every number but the grid size be missing', () => {
		const m = parseMeta({ width: 2, height: 2 });
		expect(m).toMatchObject({ pixelPitchXUm: null, pixelPitchYUm: null, zMinUm: null, zMaxUm: null, sourceFormat: null });
	});
	it('ignores a pitch that is zero, negative or not a number', () => {
		expect(parseMeta({ ...META, pixel_pitch_x_um: 0, pixel_pitch_y_um: 'x' })).toMatchObject({ pixelPitchXUm: null, pixelPitchYUm: null });
	});
	it('refuses what is not a grid description', () => {
		for (const bad of [null, 'x', {}, { width: 0, height: 4 }, { width: 2.5, height: 4 }, { width: 1, height: 9 }, { width: 1025, height: 4 }, { width: 4, height: 5000 }]) {
			expect(() => parseMeta(bad)).toThrow(ScanDataError);
		}
	});
});

describe('decodeGrid', () => {
	const meta = parseMeta({ width: 2, height: 2 });
	it('reads little-endian float32, NaN included', () => {
		const view = new DataView(new ArrayBuffer(16));
		[1.5, NaN, -3, 0].forEach((v, i) => view.setFloat32(i * 4, v, true));
		const grid = decodeGrid(view.buffer, meta);
		expect(grid[0]).toBe(1.5);
		expect(Number.isNaN(grid[1])).toBe(true);
		expect(grid[2]).toBe(-3);
	});
	it('refuses a length that does not match the meta', () => {
		expect(() => decodeGrid(new ArrayBuffer(12), meta)).toThrow(/needs? 16|need 16/);
	});
	it('returns a copy, not a view of the response', () => {
		const buf = new Float32Array([1, 2, 3, 4]).buffer;
		const grid = decodeGrid(buf, meta);
		new Float32Array(buf)[0] = 99;
		expect(grid[0]).toBe(1);
	});
});

describe('gridStats', () => {
	it('skips NaN and infinities', () => {
		expect(gridStats(new Float32Array([3, NaN, -1, Infinity, 7]))).toEqual({ min: -1, max: 7, valid: 3, missing: 2 });
	});
	it('is zero for a grid with no data', () => {
		expect(gridStats(new Float32Array([NaN, NaN]))).toEqual({ min: 0, max: 0, valid: 0, missing: 2 });
	});
});

describe('buildTextureData', () => {
	it('pairs each height with a 1 when it has data', () => {
		const { data } = buildTextureData(new Float32Array([1, 2, 3, 4]), 2, 2);
		expect(Array.from(data)).toEqual([1, 1, 2, 1, 3, 1, 4, 1]);
	});
	it('never lets a NaN through, and marks the cell as having no data', () => {
		const grid = new Float32Array([1, NaN, 3, 3]);
		const { data, stats } = buildTextureData(grid, 2, 2);
		expect(Array.from(data).some(Number.isNaN)).toBe(false);
		expect(data[3]).toBe(0); // the mask of cell 1
		expect(data[2]).toBeCloseTo(2, 5); // filled from its known neighbours (1 on the left, 3 below)
		expect(stats.missing).toBe(1);
	});
	it('fills a wide hole from its rim, never with 0', () => {
		const w = 7;
		const grid = new Float32Array(w * 3).fill(10);
		for (let x = 1; x < 6; x++) grid[w + x] = NaN; // the middle row, apart from its ends
		const { data } = buildTextureData(grid, w, 3);
		for (let x = 0; x < w; x++) expect(data[(w + x) * 2]).toBeCloseTo(10, 5);
		for (let x = 1; x < 6; x++) expect(data[(w + x) * 2 + 1]).toBe(0);
	});
	it('says "too large" for a grid past the 1024 cap of the contract', () => {
		expect(() => parseMeta({ width: 1025, height: 8 })).toThrow(/too large/);
		expect(() => parseMeta({ width: 1024, height: 1024 })).not.toThrow();
	});
	it('leaves a grid with no data at all discarded (mask 0) and finite', () => {
		const { data } = buildTextureData(new Float32Array([NaN, NaN, NaN, NaN]), 2, 2);
		expect(Array.from(data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});
	it('fills a big hole in one sweep: 1024 x 1024 with a round scan in a square frame, and a 600-column hole', () => {
		const n = 1024;
		const round = new Float32Array(n * n);
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) round[y * n + x] = (x - 512) ** 2 + (y - 512) ** 2 < 500 ** 2 ? 5 + x / n : NaN;
		}
		const wide = new Float32Array(n * n).fill(3);
		for (let y = 0; y < n; y++) for (let x = 200; x < 800; x++) wide[y * n + x] = NaN;
		for (const grid of [round, wide]) {
			const t0 = performance.now();
			const { data } = buildTextureData(grid, n, n);
			expect(performance.now() - t0).toBeLessThan(500);
			let bad = 0;
			for (let i = 0; i < grid.length; i++) {
				if (!Number.isFinite(data[i * 2])) bad++;
				if (Number.isFinite(grid[i]) ? data[i * 2 + 1] !== 1 : data[i * 2 + 1] !== 0) bad++;
			}
			expect(bad).toBe(0);
		}
	});
	it('fills the first rings from the rim and carries the nearest value deeper in', () => {
		const w = 9;
		const grid = new Float32Array(w * 3).fill(10);
		for (let x = 0; x < w; x++) grid[w + x] = x === 0 ? 2 : x === w - 1 ? 20 : NaN;
		const { data } = buildTextureData(grid, w, 3);
		const row = (x: number) => data[(w + x) * 2];
		expect(row(1)).toBeGreaterThan(2);
		expect(row(1)).toBeLessThan(10);
		for (let x = 1; x < w - 1; x++) expect(row(x)).toBeGreaterThanOrEqual(2);
		for (let x = 1; x < w - 1; x++) expect(row(x)).toBeLessThanOrEqual(20);
	});
	it('refuses a grid that does not fit its size', () => {
		expect(() => buildTextureData(new Float32Array(5), 2, 2)).toThrow(ScanDataError);
	});
});
