// Characterisation test, written BEFORE the path-model refactor (see
// docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md,
// "Protecting what works today"). It pins today's exact buildCloud() output across a
// representative parameter matrix. The refactored buildPath()+buildCloud() MUST
// reproduce these values exactly (x/y agree; the new stride-3 pos carries z=0).
// DO NOT edit the committed snapshot file to make a later change pass — a snapshot
// diff here means the refactor changed geometry, which is exactly what this guards.
import { describe, expect, it } from 'vitest';
import { buildCloud, COLORMAPS, type CloudParams } from './liveCloud';
import type { Cache } from './liveCache';

function makeCache(): Cache {
	const N = 60;
	const t = Float32Array.from({ length: N }, (_, i) => i * 0.01);
	const revs = Float32Array.from({ length: N }, (_, i) => i * 0.03);
	const mk = (f: (i: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i));
	return {
		N, Fs: 1000, feed: 0.05, diam: 80, csSec: 0, ceSec: (N - 1) * 0.01,
		t, revs,
		Fx: mk((i) => Math.sin(i * 0.2) * 30),
		Fy: mk((i) => Math.cos(i * 0.2) * 30),
		Fz: mk((i) => Math.sin(i * 0.31) * 50 + 10),
		rpm: mk(() => 1200),
	};
}

// Base path/window match the pre-refactor defaults exactly (turning_spiral, feed=0.05,
// diam=80, innerDiam=0, measured, cropStart=0, cropEnd=1e9, stride=1).
function basePath(overrides: Partial<CloudParams['path']> = {}): CloudParams['path'] {
	return {
		kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
		speedMode: 'measured', rpm: 1200, vc: 0, timeScale: 1, ppr: 1,
		...overrides,
	} as CloudParams['path'];
}
function baseWindow(overrides: Partial<CloudParams['window']> = {}): CloudParams['window'] {
	return { cropStartSec: 0, cropEndSec: 1e9, stride: 1, ...overrides };
}
function baseParams(overrides: Partial<CloudParams> = {}): CloudParams {
	return {
		channel: 'Fz',
		path: basePath(),
		window: baseWindow(),
		gridding: false, gridN: 20,
		colormap: COLORMAPS.viridis,
		cmin: null, cmax: null, zSeries: 'none',
		...overrides,
	};
}

// Each case name documents which axis of the matrix it exercises. Same 9 cases as the
// pre-refactor version of this file, translated to the new nested CloudParams shape.
const CASES: [string, Partial<CloudParams>][] = [
	['measured-raw', {}],
	['rpm-model', { path: basePath({ speedMode: 'rpm', rpm: 900 }) }],
	['vc-model', { path: basePath({ speedMode: 'vc', vc: 120 }) }],
	['gridded', { gridding: true, gridN: 12 }],
	['stride-5', { window: baseWindow({ stride: 5 }) }],
	['inner-diam-20', { path: basePath({ innerDiam: 20 }) }],
	['z-series-fx', { zSeries: 'Fx' }],
	['truncating-crop', { window: baseWindow({ cropStartSec: 0.1, cropEndSec: 0.3 }) }],
	['manual-climits', { cmin: -10, cmax: 10 }],
];

describe('buildCloud golden values (pre-refactor characterisation)', () => {
	const cache = makeCache();
	for (const [name, overrides] of CASES) {
		it(`matches the frozen snapshot: ${name}`, () => {
			const cloud = buildCloud(cache, baseParams(overrides));
			expect(cloud).not.toBeNull();
			const n = cloud!.count;
			// pos is now stride-3 (z=0 for every point on this flat turning-spiral path); drop z
			// and compare the x/y pairs against the frozen stride-2 snapshot, so a genuine geometry
			// regression still fails this test instead of being masked by the format change.
			const pos2 = new Array<number>(n * 2);
			for (let k = 0; k < n; k++) {
				expect(cloud!.pos[k * 3 + 2]).toBe(0);
				pos2[k * 2] = cloud!.pos[k * 3]; pos2[k * 2 + 1] = cloud!.pos[k * 3 + 1];
			}
			expect({
				count: cloud!.count,
				pos: pos2,
				col: Array.from(cloud!.col!),
				bounds: [cloud!.bounds.minX, cloud!.bounds.maxX, cloud!.bounds.minY, cloud!.bounds.maxY],
				climits: [cloud!.cmin, cloud!.cmax],
				zv: cloud!.zv ? Array.from(cloud!.zv) : null,
			}).toMatchSnapshot();
		});
	}
});
