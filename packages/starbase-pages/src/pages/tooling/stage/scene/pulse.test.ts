import { describe, expect, it } from 'vitest';
import { PULSE_CYCLES, PULSE_CYCLE_MS, PULSE_DURATION_MS, pulseLevel, pulseRunning } from './pulse';

describe('pulseRunning', () => {
	it('runs for about three cycles (2.4 s) from its start, then stops', () => {
		expect(PULSE_DURATION_MS).toBe(PULSE_CYCLES * PULSE_CYCLE_MS);
		expect(PULSE_DURATION_MS).toBeGreaterThanOrEqual(2300);
		expect(PULSE_DURATION_MS).toBeLessThanOrEqual(2500);
		expect(pulseRunning(1000, 1000)).toBe(true);
		expect(pulseRunning(1000, 1000 + PULSE_DURATION_MS - 1)).toBe(true);
		expect(pulseRunning(1000, 1000 + PULSE_DURATION_MS)).toBe(false);
		expect(pulseRunning(1000, 1000 + 60_000)).toBe(false);
	});

	it('is not running before a start is set', () => {
		expect(pulseRunning(null, 5000)).toBe(false);
	});

	it('treats a clock that has not reached the start as the start', () => {
		expect(pulseRunning(1000, 900)).toBe(true);
	});
});

describe('pulseLevel', () => {
	it('starts and ends at full strength so the final static frame matches the last animated one', () => {
		expect(pulseLevel(0, 0)).toBeCloseTo(1, 9);
		expect(pulseLevel(0, PULSE_DURATION_MS)).toBe(1);
		expect(pulseLevel(0, PULSE_DURATION_MS - 1e-6)).toBeCloseTo(1, 6);
	});

	it('dips in between, within 0..1', () => {
		expect(pulseLevel(0, PULSE_CYCLE_MS / 2)).toBeCloseTo(0, 9);
		for (let t = 0; t < PULSE_DURATION_MS; t += 37) {
			const v = pulseLevel(0, t);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it('is full strength when there is no pulse', () => {
		expect(pulseLevel(null, 123)).toBe(1);
	});
});
