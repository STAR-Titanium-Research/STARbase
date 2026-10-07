import { describe, expect, it } from 'vitest';
import { createEmitThrottle } from './emitThrottle';

describe('createEmitThrottle (#103)', () => {
	it('publishes the first change at once and throttles the rest', () => {
		const th = createEmitThrottle(100);
		expect(th.mark(0)).toBe(true);
		expect(th.mark(30)).toBe(false);
		expect(th.mark(60)).toBe(false);
		expect(th.mark(100)).toBe(true);
	});

	it('publishes the last throttled change on the trailing edge', () => {
		// The reported bug: a reset published an empty histogram, the refill in the same frame was
		// throttled, and with playback paused nothing ever published it.
		const th = createEmitThrottle(100);
		expect(th.mark(0, true)).toBe(true);    // the reset's forced emit
		expect(th.mark(5)).toBe(false);         // the refill, throttled
		expect(th.pending).toBe(true);
		expect(th.flush(50)).toBe(false);       // not yet
		expect(th.flush(100)).toBe(true);       // published once the interval has passed
		expect(th.flush(300)).toBe(false);      // and only once
	});

	it('a forced change always publishes and clears anything pending', () => {
		const th = createEmitThrottle(100);
		th.mark(0);
		th.mark(10);
		expect(th.mark(20, true)).toBe(true);
		expect(th.pending).toBe(false);
		expect(th.flush(500)).toBe(false);
	});

	it('flush does nothing when nothing changed', () => {
		const th = createEmitThrottle(100);
		expect(th.flush(1000)).toBe(false);
		th.mark(0);
		expect(th.flush(1000)).toBe(false);
	});
});
