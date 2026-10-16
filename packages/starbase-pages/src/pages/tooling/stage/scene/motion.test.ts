import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	easeInOutCubic, easeOutCubic, FLIGHT_MS, HOVER_DOWN_MS, HOVER_UP_MS, motionMs, prefersReducedMotion, RECENTRE_MS, REDUCED_SCALE,
} from './motion';

afterEach(() => vi.unstubAllGlobals());

describe('motionMs: everything animates', () => {
	it('keeps a duration as it is, and shortens it a little (x0.75) under reduced motion, never to nothing', () => {
		expect(REDUCED_SCALE).toBe(0.75);
		for (const ms of [FLIGHT_MS, RECENTRE_MS, HOVER_UP_MS, HOVER_DOWN_MS]) {
			expect(motionMs(ms, false)).toBe(ms);
			expect(motionMs(ms, true)).toBeCloseTo(ms * 0.75, 9);
			expect(motionMs(ms, true)).toBeGreaterThan(0);
		}
		expect(motionMs(0, true)).toBeGreaterThan(0);
	});

	it('reads the media query when not told', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') }));
		expect(prefersReducedMotion()).toBe(true);
		expect(motionMs(400)).toBe(300);
		vi.stubGlobal('matchMedia', () => ({ matches: false }));
		expect(motionMs(400)).toBe(400);
		vi.stubGlobal('matchMedia', undefined);
		expect(motionMs(400)).toBe(400);
	});

	it('has the durations the maintainer asked for: flights about 400 ms, recentre at most 400, a quick hover', () => {
		expect(FLIGHT_MS).toBe(400);
		expect(RECENTRE_MS).toBeLessThanOrEqual(400);
		expect(HOVER_UP_MS).toBe(150);
		expect(HOVER_DOWN_MS).toBe(200);
	});
});

describe('the eases', () => {
	it('start at 0, end at 1, clamp, and never go backwards', () => {
		for (const ease of [easeInOutCubic, easeOutCubic]) {
			expect(ease(0)).toBe(0);
			expect(ease(1)).toBe(1);
			expect(ease(-2)).toBe(0);
			expect(ease(3)).toBe(1);
			let last = 0;
			for (let i = 0; i <= 50; i++) { const v = ease(i / 50); expect(v).toBeGreaterThanOrEqual(last); last = v; }
		}
	});

	it('ease-in-out is slow at both ends and fast in the middle, ease-out fast at the start only', () => {
		expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
		expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
		expect(easeOutCubic(0.1)).toBeGreaterThan(0.1);
		expect(easeOutCubic(0.9)).toBeGreaterThan(0.99);
	});
});
