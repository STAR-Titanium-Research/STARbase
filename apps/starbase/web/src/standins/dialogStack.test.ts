import { afterEach, describe, expect, it, vi } from 'vitest';
import { escHandler, isTopDialog, openDialogCount, popDialog, pushDialog, restoreFocus } from './dialogStack';

const a = Symbol('a');
const b = Symbol('b');
const c = Symbol('c');
afterEach(() => [a, b, c].forEach(popDialog));

describe('the open-dialog stack (Esc belongs to the topmost dialog)', () => {
	it('only the most recently opened dialog is on top', () => {
		pushDialog(a);
		expect(isTopDialog(a)).toBe(true);
		pushDialog(b);
		expect([isTopDialog(a), isTopDialog(b)]).toEqual([false, true]);
	});
	it('closing the top hands Esc back to the one beneath', () => {
		pushDialog(a);
		pushDialog(b);
		popDialog(b);
		expect([isTopDialog(a), isTopDialog(b)]).toEqual([true, false]);
		expect(openDialogCount()).toBe(1);
	});
	it('a dialog closed out of order leaves the others in order', () => {
		pushDialog(a);
		pushDialog(b);
		pushDialog(c);
		popDialog(b);
		expect(isTopDialog(c)).toBe(true);
		popDialog(c);
		expect(isTopDialog(a)).toBe(true);
	});
	it('pushing twice does not duplicate, and popping an unknown dialog is harmless', () => {
		pushDialog(a);
		pushDialog(a);
		popDialog(b);
		expect(openDialogCount()).toBe(1);
		popDialog(a);
		expect(openDialogCount()).toBe(0);
		expect(isTopDialog(a)).toBe(false);
	});
});

describe('restoreFocus', () => {
	it('focuses the opener when it is still in the document', () => {
		const focus = vi.fn();
		restoreFocus({ isConnected: true, focus });
		expect(focus).toHaveBeenCalledTimes(1);
	});
	it('does nothing when the opener has gone, or there was none', () => {
		const focus = vi.fn();
		restoreFocus({ isConnected: false, focus });
		restoreFocus(null);
		expect(focus).not.toHaveBeenCalled();
	});
});

describe('escHandler: the document listener each open dialog installs', () => {
	const press = (h: (e: { key: string; stopPropagation(): void }) => void, key = 'Escape') => {
		const stopPropagation = vi.fn();
		h({ key, stopPropagation });
		return stopPropagation;
	};
	it('two stacked dialogs: one Esc reaches only the top one', () => {
		const lower = vi.fn();
		const upper = vi.fn();
		pushDialog(a);
		pushDialog(b);
		const hLower = escHandler(a, lower);
		const hUpper = escHandler(b, upper);
		// the document calls every listener, in registration order
		[hLower, hUpper].forEach((h) => press(h));
		expect([lower.mock.calls.length, upper.mock.calls.length]).toEqual([0, 1]);
		popDialog(b); // the top one closes; the next Esc is the lower one's
		[hLower, hUpper].forEach((h) => press(h));
		expect([lower.mock.calls.length, upper.mock.calls.length]).toEqual([1, 1]);
	});
	it('ignores other keys', () => {
		const onEsc = vi.fn();
		pushDialog(a);
		press(escHandler(a, onEsc), 'Enter');
		expect(onEsc).not.toHaveBeenCalled();
	});
});
