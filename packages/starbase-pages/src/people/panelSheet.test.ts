import { describe, expect, it } from 'vitest';
import { backdropDismiss, tabWrapTarget, useNarrowPanel } from './panelSheet';

describe('backdropDismiss', () => {
	it('closes only when the press started and the click ended on the backdrop', () => {
		expect(backdropDismiss(true, true)).toBe(true);
		expect(backdropDismiss(true, false)).toBe(false);
		expect(backdropDismiss(false, true)).toBe(false); // pressed inside the sheet, released outside it
		expect(backdropDismiss(false, false)).toBe(false);
	});
});

describe('tabWrapTarget', () => {
	it('wraps forward from the last control to the first', () => {
		expect(tabWrapTarget(4, 3, false)).toBe(0);
		expect(tabWrapTarget(4, 1, false)).toBeNull();
	});
	it('wraps backward from the first control, or from the sheet itself, to the last', () => {
		expect(tabWrapTarget(4, 0, true)).toBe(3);
		expect(tabWrapTarget(4, -1, true)).toBe(3);
		expect(tabWrapTarget(4, 2, true)).toBeNull();
	});
	it('leaves Tab alone when the sheet has nothing to focus', () => {
		expect(tabWrapTarget(0, -1, false)).toBeNull();
		expect(tabWrapTarget(0, -1, true)).toBeNull();
	});
	it('lets Tab from the sheet itself go forward as usual', () => {
		expect(tabWrapTarget(3, -1, false)).toBeNull();
	});
});

describe('useNarrowPanel', () => {
	type Listener = (e: { matches: boolean }) => void;
	const fakeQuery = (matches: boolean) => {
		const listeners = new Set<Listener>();
		return {
			matches,
			addEventListener: (_: string, l: Listener) => void listeners.add(l),
			removeEventListener: (_: string, l: Listener) => void listeners.delete(l),
			change: (m: boolean) => listeners.forEach((l) => l({ matches: m })),
		};
	};

	it('is narrow when the wide query does not match, and follows it', () => {
		const mq = fakeQuery(false);
		const narrow = useNarrowPanel(mq as never);
		expect(narrow.value).toBe(true);
		mq.change(true);
		expect(narrow.value).toBe(false);
	});
	it('is false where there is no matchMedia (server rendering)', () => {
		expect(useNarrowPanel(null).value).toBe(false);
	});
});
