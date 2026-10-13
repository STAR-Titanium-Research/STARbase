import { describe, expect, it } from 'vitest';
import { ORB_PRESETS, orbFrame, orbPreset } from './thinkingOrb';

describe('orbFrame', () => {
	it('draws all three strands plus the ghost sphere', () => {
		const dots = orbFrame(64, 1.3, ORB_PRESETS[64].opts);
		const strands = new Set(dots.map((d) => d.strand));
		expect([...strands].sort()).toEqual([-1, 0, 1, 2]);
	});

	it('returns dots sorted far to near, so nearer dots paint on top', () => {
		const dots = orbFrame(20, 4.2, ORB_PRESETS[20].opts);
		for (let i = 1; i < dots.length; i++) expect(dots[i].z).toBeGreaterThanOrEqual(dots[i - 1].z);
	});

	it('keeps every dot inside the canvas, visible and at least the minimum radius', () => {
		for (const size of [14, 20, 32, 64]) {
			const o = orbPreset(size).opts;
			for (const t of [0, 0.6, 7.9, 123.4]) {
				for (const d of orbFrame(size, t, o)) {
					expect(d.x - d.r).toBeGreaterThanOrEqual(0);
					expect(d.y - d.r).toBeGreaterThanOrEqual(0);
					expect(d.x + d.r).toBeLessThanOrEqual(size);
					expect(d.y + d.r).toBeLessThanOrEqual(size);
					expect(d.a).toBeGreaterThanOrEqual(0.02);
					expect(d.a).toBeLessThanOrEqual(1);
					expect(d.r).toBeGreaterThanOrEqual(o.rMin);
				}
			}
		}
	});

	it('is deterministic for a given clock, and moves as the clock advances', () => {
		const o = ORB_PRESETS[64].opts;
		expect(orbFrame(64, 2, o)).toEqual(orbFrame(64, 2, o));
		expect(orbFrame(64, 2.1, o)).not.toEqual(orbFrame(64, 2, o));
	});
});

describe('orbPreset', () => {
	it('uses the inline design below 24 px and the large one from 24 px', () => {
		expect(orbPreset(14)).toBe(ORB_PRESETS[20]);
		expect(orbPreset(23)).toBe(ORB_PRESETS[20]);
		expect(orbPreset(24)).toBe(ORB_PRESETS[64]);
		expect(orbPreset(64)).toBe(ORB_PRESETS[64]);
	});

	it('matches the upstream tuning for the dot counts', () => {
		expect(ORB_PRESETS[64].opts).toMatchObject({ strandN: 26, ghostN: 75 });
		expect(ORB_PRESETS[20].opts).toMatchObject({ strandN: 6, ghostN: 17 });
	});
});
