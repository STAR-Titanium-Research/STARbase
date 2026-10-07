import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, isTouchContextMenu, type PressEvent } from './longPress';

const touch = (id: number, x: number, y: number): PressEvent => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y });

describe('createLongPress', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('fires once with the client point after the hold', () => {
		const got: [number, number][] = [];
		const lp = createLongPress((x, y) => got.push([x, y]));
		lp.down(touch(1, 100, 200));
		vi.advanceTimersByTime(499);
		expect(got).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(got).toEqual([[100, 200]]);
		vi.advanceTimersByTime(5000);
		expect(got).toHaveLength(1);
		lp.up(touch(1, 100, 200));
		expect(lp.touching).toBe(false);
	});
	it('a release before the hold cancels it', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 10, 10));
		vi.advanceTimersByTime(300);
		lp.up(touch(1, 10, 10));
		vi.advanceTimersByTime(1000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('movement within the slop keeps it, and the menu opens at the finger\'s latest point', () => {
		const got: [number, number][] = [];
		const lp = createLongPress((x, y) => got.push([x, y]));
		lp.down(touch(1, 100, 100));
		lp.move(touch(1, 104, 103));
		vi.advanceTimersByTime(500);
		expect(got).toEqual([[104, 103]]);
	});
	it('movement beyond the slop cancels it (a pan)', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 100, 100));
		lp.move(touch(1, 100, 111));
		vi.advanceTimersByTime(2000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('a slow drift that adds up past the slop cancels it too', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 100, 100));
		for (let k = 1; k <= 8; k++) lp.move(touch(1, 100 + k * 2, 100));   // 2 px per move, 16 px in all
		vi.advanceTimersByTime(2000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('a second finger cancels it, and stays cancelled when the second lifts', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 100, 100));
		vi.advanceTimersByTime(200);
		lp.down(touch(2, 150, 100));
		lp.up(touch(2, 150, 100));
		vi.advanceTimersByTime(2000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('pointercancel cancels it', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 5, 5));
		lp.up(touch(1, 5, 5));
		vi.advanceTimersByTime(1000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('a release after it fired clears the touch', () => {
		const lp = createLongPress(() => {});
		lp.down(touch(1, 5, 5));
		vi.advanceTimersByTime(500);
		lp.up(touch(1, 5, 5));
		expect(lp.touching).toBe(false);
	});
	it('ignores mouse and pen', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down({ pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
		lp.down({ pointerId: 2, pointerType: 'pen', clientX: 0, clientY: 0 });
		vi.advanceTimersByTime(2000);
		expect(onPress).not.toHaveBeenCalled();
		expect(lp.touching).toBe(false);
		lp.up({ pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
		expect(lp.touching).toBe(false);
	});
	it('arms again for the next touch after a fired one', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down(touch(1, 1, 1)); vi.advanceTimersByTime(500); lp.up(touch(1, 1, 1));
		lp.down(touch(2, 2, 2)); vi.advanceTimersByTime(500);
		expect(onPress).toHaveBeenCalledTimes(2);
		expect(onPress).toHaveBeenLastCalledWith(2, 2);
	});
	it('reports a touch on the screen, and cancel() drops a pending hold', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		expect(lp.touching).toBe(false);
		lp.down(touch(1, 1, 1));
		expect(lp.touching).toBe(true);
		lp.cancel();
		expect(lp.touching).toBe(false);
		vi.advanceTimersByTime(1000);
		expect(onPress).not.toHaveBeenCalled();
	});

	it('a primary touch starts a new gesture: a stale pointer left by a lost pointerup does not block it', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down({ ...touch(1, 10, 10), isPrimary: true });   // its pointerup never arrives (canvas swapped)
		lp.down({ ...touch(2, 50, 50), isPrimary: true });   // a new gesture
		expect(lp.touching).toBe(true);
		vi.advanceTimersByTime(500);
		expect(onPress).toHaveBeenCalledOnce();
		expect(onPress).toHaveBeenCalledWith(50, 50);
		lp.up({ ...touch(2, 50, 50), isPrimary: true });
		expect(lp.touching).toBe(false);   // pointer 1 was forgotten, not left behind
	});
	it('a non-primary second finger still cancels the hold', () => {
		const onPress = vi.fn();
		const lp = createLongPress(onPress);
		lp.down({ ...touch(1, 10, 10), isPrimary: true });
		lp.down({ ...touch(2, 50, 50), isPrimary: false });
		vi.advanceTimersByTime(2000);
		expect(onPress).not.toHaveBeenCalled();
	});
	it('cancel() forgets every pointer', () => {
		const lp = createLongPress(vi.fn());
		lp.down({ ...touch(1, 10, 10), isPrimary: true });
		lp.cancel();
		expect(lp.touching).toBe(false);
	});
});

describe('isTouchContextMenu', () => {
	const ev = (pointerType?: string) => ({ pointerType }) as unknown as MouseEvent;
	it('swallows the echo of a touch hold only while a touch is down', () => {
		expect(isTouchContextMenu(ev('touch'), true)).toBe(true);
		expect(isTouchContextMenu(ev(undefined), true)).toBe(true);   // browsers whose contextmenu has no pointerType
		expect(isTouchContextMenu(ev('touch'), false)).toBe(false);
	});
	it('never swallows a mouse right-click, even with a finger down', () => {
		expect(isTouchContextMenu(ev('mouse'), true)).toBe(false);
		expect(isTouchContextMenu(ev('mouse'), false)).toBe(false);
	});
});
