import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusIdFrom, waitFor, withoutFocus } from './focusLink';

describe('focusIdFrom', () => {
	it('reads a plain id', () => {
		expect(focusIdFrom({ focus: 'backup-url' })).toBe('backup-url');
	});
	it('takes the first of a repeated parameter', () => {
		expect(focusIdFrom({ focus: ['a', 'b'] })).toBe('a');
	});
	it('ignores a missing or blank value', () => {
		expect(focusIdFrom({})).toBeNull();
		expect(focusIdFrom({ focus: '  ' })).toBeNull();
		expect(focusIdFrom({ focus: null })).toBeNull();
	});
});

describe('withoutFocus', () => {
	it('drops only the focus key', () => {
		expect(withoutFocus({ tab: 'connectivity', focus: 'x' })).toEqual({ tab: 'connectivity' });
	});
});

describe('waitFor', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('resolves immediately when the target already exists', async () => {
		await expect(waitFor(() => 'el')).resolves.toBe('el');
	});

	it('keeps polling until a late target appears', async () => {
		vi.useFakeTimers();
		let el: string | null = null;
		const p = waitFor(() => el, 2000, 50);
		await vi.advanceTimersByTimeAsync(300);
		el = 'late';
		await vi.advanceTimersByTimeAsync(60);
		await expect(p).resolves.toBe('late');
	});

	it('gives up with null after the timeout', async () => {
		vi.useFakeTimers();
		const p = waitFor(() => null, 2000, 50);
		await vi.advanceTimersByTimeAsync(2100);
		await expect(p).resolves.toBeNull();
	});
});
