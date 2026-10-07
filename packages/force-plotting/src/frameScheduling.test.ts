import { describe, expect, it } from 'vitest';
import { createFrameGate, createTrailingThrottle } from './frameScheduling';

// A manual clock: callbacks run only when the test says so.
function fakeTimers() {
	let next = 1;
	const q = new Map<number, () => void>();
	return {
		set: (cb: () => void) => { const id = next++; q.set(id, cb); return id; },
		clear: (id: number) => { q.delete(id); },
		flush() { const all = [...q.entries()]; q.clear(); all.forEach(([, cb]) => cb()); },
		size: () => q.size,
	};
}

describe('createFrameGate', () => {
	it('coalesces requests into one frame', () => {
		const t = fakeTimers(); const g = createFrameGate(t.set, t.clear);
		let n = 0;
		g.request(() => n++); g.request(() => n++);
		expect(t.size()).toBe(1);
		t.flush();
		expect(n).toBe(1);
		expect(g.pending).toBe(false);
	});
	// The deactivate -> reactivate bug: the queued frame is cancelled, the id was left set, and
	// every later request() returned early so the cloud never drew again.
	it('schedules again after cancel() (reactivation)', () => {
		const t = fakeTimers(); const g = createFrameGate(t.set, t.clear);
		let n = 0;
		g.request(() => n++);
		g.cancel();
		expect(g.pending).toBe(false);
		g.request(() => n++);
		t.flush();
		expect(n).toBe(1);
	});
});

describe('createTrailingThrottle', () => {
	it('runs immediately, then once more for triggers inside the window', () => {
		const t = fakeTimers(); let n = 0;
		const th = createTrailingThrottle(() => n++, 80, t.set, t.clear);
		th.trigger(); th.trigger(); th.trigger();
		expect(n).toBe(1);
		t.flush();
		expect(n).toBe(2);
		t.flush();
		expect(th.pending).toBe(false);
	});
	it('runs immediately again after cancel() even if a window was open (reactivation)', () => {
		const t = fakeTimers(); let n = 0;
		const th = createTrailingThrottle(() => n++, 80, t.set, t.clear);
		th.trigger(); th.trigger();   // window open, trailing queued
		th.cancel();
		expect(th.pending).toBe(false);
		th.trigger();
		expect(n).toBe(2);
		t.flush();
		expect(n).toBe(2);   // the cancelled trailing run does not fire
	});
});
