import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollToSection } from './scrollTo';

// A stand-in for an element: a tabindex attribute store and a focus spy.
function fakeEl(attrs: Record<string, string> = {}) {
	const store = { ...attrs };
	return {
		scrollIntoView: vi.fn(),
		focus: vi.fn(),
		hasAttribute: (n: string) => n in store,
		setAttribute: (n: string, v: string) => void (store[n] = v),
		getAttribute: (n: string) => store[n] ?? null,
	};
}
const click = (over: Record<string, unknown> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...over });

afterEach(() => vi.unstubAllGlobals());

describe('scrollToSection', () => {
	it('scrolls the section to the top, sets the hash without navigating and stops the click', () => {
		const el = fakeEl();
		const replaceState = vi.fn();
		vi.stubGlobal('document', { getElementById: (id: string) => (id === 'campaigns' ? el : null) });
		vi.stubGlobal('history', { state: { s: 1 }, replaceState });
		const e = click();
		expect(scrollToSection('campaigns', e)).toBe(true);
		expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
		expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '#campaigns');
		expect(e.preventDefault).toHaveBeenCalled();
	});

	it('moves focus to the section without scrolling again, making it focusable first', () => {
		const el = fakeEl();
		vi.stubGlobal('document', { getElementById: () => el });
		vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
		scrollToSection('x', click());
		expect(el.getAttribute('tabindex')).toBe('-1');
		expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('keeps a tabindex the element already has', () => {
		const el = fakeEl({ tabindex: '0' });
		vi.stubGlobal('document', { getElementById: () => el });
		vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
		scrollToSection('x', click());
		expect(el.getAttribute('tabindex')).toBe('0');
	});

	it('leaves a modified click and a missing section to the browser', () => {
		vi.stubGlobal('document', { getElementById: () => fakeEl() });
		for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
			const e = click(over);
			expect(scrollToSection('x', e)).toBe(false);
			expect(e.preventDefault).not.toHaveBeenCalled();
		}
		vi.stubGlobal('document', { getElementById: () => null });
		const e = click();
		expect(scrollToSection('gone', e)).toBe(false);
		expect(e.preventDefault).not.toHaveBeenCalled();
	});
});
