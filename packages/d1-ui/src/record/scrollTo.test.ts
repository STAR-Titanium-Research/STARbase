import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollToSection } from './scrollTo';

const click = (over: Record<string, unknown> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...over });

afterEach(() => vi.unstubAllGlobals());

describe('scrollToSection', () => {
	it('scrolls the section to the top, sets the hash without navigating and stops the click', () => {
		const scrollIntoView = vi.fn();
		const replaceState = vi.fn();
		vi.stubGlobal('document', { getElementById: (id: string) => (id === 'campaigns' ? { scrollIntoView } : null) });
		vi.stubGlobal('history', { state: { s: 1 }, replaceState });
		const e = click();
		expect(scrollToSection('campaigns', e)).toBe(true);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
		expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '#campaigns');
		expect(e.preventDefault).toHaveBeenCalled();
	});

	it('leaves a modified click and a missing section to the browser', () => {
		vi.stubGlobal('document', { getElementById: () => ({ scrollIntoView: vi.fn() }) });
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
