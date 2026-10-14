import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULSE_DURATION_MS } from './pulse';
import { RenderLoop, type LoopHost } from './renderLoop';

// A manual requestAnimationFrame: frames run only when the test steps the clock.
let queue: Array<(t: number) => void> = [];
let clock = 0;
const step = (ms: number): void => {
	clock += ms;
	const run = queue;
	queue = [];
	for (const cb of run) cb(clock);
};
const settle = (frames: number, ms = 16): void => {
	for (let i = 0; i < frames && queue.length; i++) step(ms);
};

beforeEach(() => {
	queue = [];
	clock = 1000;
	vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => queue.push(cb));
	vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
	vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function host(over: Partial<LoopHost> = {}): LoopHost & { levels: number[] } {
	const levels: number[] = [];
	return { levels, ready: () => true, pulseAllowed: () => true, advance: () => false, draw: (p) => { levels.push(p); }, ...over };
}

describe('RenderLoop', () => {
	it('draws once for a request and then schedules nothing', () => {
		const h = host({ pulseAllowed: () => false });
		const loop = new RenderLoop(h);
		loop.request();
		loop.request();
		settle(5);
		expect(h.levels).toEqual([1]);
		expect(queue.length).toBe(0);
	});

	it('pulses for a bounded time after a restart, then draws one static frame at full strength and stops', () => {
		const h = host();
		const loop = new RenderLoop(h);
		loop.restartPulse();
		loop.request();
		settle(Math.ceil(PULSE_DURATION_MS / 16) + 20);
		expect(queue.length).toBe(0); // no render loop at rest
		expect(h.levels.length).toBeGreaterThan(10);
		expect(h.levels.length).toBeLessThan(PULSE_DURATION_MS / 16); // throttled to about 30 fps
		expect(Math.min(...h.levels)).toBeLessThan(0.5); // it did pulse
		expect(h.levels[h.levels.length - 1]).toBe(1); // and ended on the static frame
	});

	it('does not pulse when the host says it may not (reduced motion, hidden tab)', () => {
		const h = host({ pulseAllowed: () => false });
		const loop = new RenderLoop(h);
		loop.restartPulse();
		loop.request();
		settle(10);
		expect(h.levels).toEqual([1]);
	});

	it('keeps going while the host is busy, and folds requests made during a frame into it', () => {
		let busyFrames = 3;
		const ref: { loop?: RenderLoop } = {};
		const h = host({
			pulseAllowed: () => false,
			advance: () => {
				ref.loop?.request();
				return --busyFrames > 0;
			},
		});
		ref.loop = new RenderLoop(h);
		ref.loop.request();
		settle(10);
		expect(h.levels.length).toBe(3);
		expect(queue.length).toBe(0);
	});

	it('does nothing once disposed, or while the host is not ready', () => {
		const h = host();
		const loop = new RenderLoop(h);
		loop.request();
		loop.dispose();
		settle(3);
		expect(h.levels).toEqual([]);
		const idle = host({ ready: () => false });
		new RenderLoop(idle).request();
		settle(3);
		expect(idle.levels).toEqual([]);
	});
});
