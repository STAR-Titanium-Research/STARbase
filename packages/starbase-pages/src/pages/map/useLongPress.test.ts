import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, createPointerKind } from './useLongPress';

describe('createLongPress (spec D24)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('fires with what was pressed after 500 ms', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire);
		p.start(100, 100, 'op:o1');
		vi.advanceTimersByTime(499);
		expect(fire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(fire).toHaveBeenCalledWith('op:o1');
	});

	it('a lift before 500 ms is a tap: nothing fires', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire);
		p.start(0, 0, 'a');
		vi.advanceTimersByTime(300);
		p.cancel();
		vi.advanceTimersByTime(1000);
		expect(fire).not.toHaveBeenCalled();
		expect(p.consumeFired()).toBe(false);
	});

	it('a move of more than 10 px cancels; 10 px or less does not', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire);
		p.start(100, 100, 'a');
		p.move(106, 108); // exactly 10 px away
		vi.advanceTimersByTime(500);
		expect(fire).toHaveBeenCalledTimes(1);

		p.start(100, 100, 'b');
		vi.advanceTimersByTime(200);
		p.move(100, 111);
		vi.advanceTimersByTime(1000);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it('measures the move from where the finger went down, not from the last move', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire);
		p.start(0, 0, 'a');
		for (const x of [4, 8, 12]) p.move(x, 0); // small steps that add up
		vi.advanceTimersByTime(600);
		expect(fire).not.toHaveBeenCalled();
	});

	it('a new press replaces the one before; the click after a fired press is swallowed once', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire);
		p.start(0, 0, 'first');
		vi.advanceTimersByTime(300);
		p.start(0, 0, 'second');
		vi.advanceTimersByTime(300);
		expect(fire).not.toHaveBeenCalled(); // the first timer is gone
		vi.advanceTimersByTime(200);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(fire).toHaveBeenCalledWith('second');
		expect(p.consumeFired()).toBe(true);
		expect(p.consumeFired()).toBe(false);
	});

	it('the delay and slop can be set', () => {
		const fire = vi.fn();
		const p = createLongPress<string>(fire, { delay: 100, slop: 2 });
		p.start(0, 0, 'a');
		p.move(3, 0);
		vi.advanceTimersByTime(200);
		expect(fire).not.toHaveBeenCalled();
	});
});

describe('createPointerKind', () => {
	it('is touch after a finger, until a mouse move or a key', () => {
		const k = createPointerKind();
		expect(k.touch).toBe(false);
		k.note('touch');
		expect(k.touch).toBe(true);
		k.note('pen'); // neither: unchanged
		expect(k.touch).toBe(true);
		k.note('mouse');
		expect(k.touch).toBe(false);
		k.note('touch');
		k.keyboard();
		expect(k.touch).toBe(false);
	});
});
