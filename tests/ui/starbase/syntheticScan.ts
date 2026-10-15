import { deflateSync } from 'node:zlib';

// A made-up topography scan for the headless specs: what the d1-surface-scan endpoint serves for a rendered
// scan (docs/superpowers/specs/2026-10-15-surface-scans-design.md, "Derived data"): grid.bin (float32 little-endian,
// row-major, top row first, micrometres, NaN = no data), meta.json and a PNG thumbnail. The surface is a cutting-edge
// flank: a gentle slope, a worn groove across the middle, some roughness, and two patches of "no data" (a hole and
// a dead strip at the left), so the viewer's shading and its discard both have something to show. No real data.

export const SCAN_W = 192;
export const SCAN_H = 128;
export const SCAN_PITCH_UM = 4;

export interface SyntheticScan {
	grid: Buffer;
	meta: Record<string, unknown>;
	thumb: Buffer;
	zMin: number;
	zMax: number;
	missing: number;
}

// A small deterministic generator, so every run draws the same surface.
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

export function syntheticScan(seed = 7): SyntheticScan {
	const rand = lcg(seed);
	const heights = new Float32Array(SCAN_W * SCAN_H);
	let zMin = Infinity;
	let zMax = -Infinity;
	let missing = 0;
	for (let y = 0; y < SCAN_H; y++) {
		for (let x = 0; x < SCAN_W; x++) {
			const u = x / (SCAN_W - 1);
			const v = y / (SCAN_H - 1);
			const slope = 6 * u - 2 * v; // a gentle tilt, micrometres
			const groove = -7 * Math.exp(-(((v - 0.5) * 7) ** 2)) * (0.6 + 0.4 * Math.sin(u * 9)); // the wear scar across the middle
			const ridge = 4 * Math.exp(-(((u - 0.82) * 14) ** 2)); // the edge's rolled-over lip
			const grit = (rand() - 0.5) * 0.7;
			let z = slope + groove + ridge + grit;
			const inHole = (x - 120) ** 2 + (y - 40) ** 2 < 7 * 7;
			const deadStrip = x < 5;
			if (inHole || deadStrip) {
				z = NaN;
				missing++;
			} else {
				zMin = Math.min(zMin, z);
				zMax = Math.max(zMax, z);
			}
			heights[y * SCAN_W + x] = z;
		}
	}
	const grid = Buffer.alloc(heights.length * 4);
	heights.forEach((h, i) => grid.writeFloatLE(h, i * 4));
	const meta = {
		width: SCAN_W,
		height: SCAN_H,
		pixel_pitch_x_um: SCAN_PITCH_UM,
		pixel_pitch_y_um: SCAN_PITCH_UM,
		z_min_um: zMin,
		z_max_um: zMax,
		source_width: SCAN_W * 4,
		source_height: SCAN_H * 4,
		source_format: 'al3d',
		decimation: { method: 'block-mean', factor: 4 },
	};
	return { grid, meta, thumb: thumbnail(heights, zMin, zMax), zMin, zMax, missing };
}

// ---- a PNG of the height map, without a dependency -----------------------------------------------------------

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
}

// A cheap blue-to-yellow ramp, enough to tell a thumbnail from a blank.
function ramp(t: number): [number, number, number] {
	const x = Math.min(1, Math.max(0, t));
	return [Math.round(68 + 185 * x), Math.round(1 + 230 * x), Math.round(84 - 47 * x)];
}

function thumbnail(heights: Float32Array, zMin: number, zMax: number): Buffer {
	const w = 96;
	const h = 64;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0; // filter: none
		for (let x = 0; x < w; x++) {
			const z = heights[Math.floor((y * SCAN_H) / h) * SCAN_W + Math.floor((x * SCAN_W) / w)];
			const [r, g, b] = Number.isFinite(z) ? ramp((z - zMin) / (zMax - zMin)) : [40, 40, 40];
			raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
