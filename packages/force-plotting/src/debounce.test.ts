import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('debounce', () => {
	// Typing "2000" in the chain editor fires four changes; only the last should fetch.
	it('collapses a burst of calls into one trailing call', () => {
		const fn = vi.fn(); const d = debounce(fn, 400);
		d(); vi.advanceTimersByTime(100); d(); vi.advanceTimersByTime(100); d(); vi.advanceTimersByTime(100); d();
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(399);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});
	it('cancel() drops the pending call (unmount)', () => {
		const fn = vi.fn(); const d = debounce(fn, 400);
		d(); expect(d.pending).toBe(true);
		d.cancel();
		vi.advanceTimersByTime(1000);
		expect(fn).not.toHaveBeenCalled();
		expect(d.pending).toBe(false);
	});
});
