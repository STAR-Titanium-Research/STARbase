import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPOTLIGHT_CLASS, SPOTLIGHT_MS, resolveSpotlightTarget, spotlight } from './spotlight';

// No DOM in this vitest environment: a minimal element with just what spotlight() touches.
function fakeEl(opts: { input?: any } = {}) {
	const classes = new Set<string>();
	return {
		classList: {
			add: (c: string) => classes.add(c),
			remove: (c: string) => classes.delete(c),
			contains: (c: string) => classes.has(c),
		},
		offsetWidth: 10,
		scrollIntoView: vi.fn(),
		matches: () => false,
		querySelector: () => opts.input ?? null,
	} as any;
}
const rootWith = (map: Record<string, any>) => ({
	querySelector: (sel: string) => {
		const m = /\[data-focus="(.+)"\]/.exec(sel);
		return (m && map[m[1]]) || null;
	},
}) as any;

describe('spotlight', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('resolves a data-focus id against the given root', () => {
		const el = fakeEl();
		expect(resolveSpotlightTarget('sample-rate', rootWith({ 'sample-rate': el }))).toBe(el);
		expect(resolveSpotlightTarget('nope', rootWith({}))).toBeNull();
		expect(resolveSpotlightTarget(el)).toBe(el);
	});

	it('escapes quotes so an odd id cannot break out of the selector', () => {
		const querySelector = vi.fn(() => null);
		resolveSpotlightTarget('a"b\\c', { querySelector } as any);
		expect(querySelector).toHaveBeenCalledWith('[data-focus="a\\"b\\\\c"]');
	});

	it('scrolls to centre, rings for the duration, then clears', () => {
		const el = fakeEl();
		expect(spotlight(el)).toBe(true);
		expect(el.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
		expect(el.classList.contains(SPOTLIGHT_CLASS)).toBe(true);
		vi.advanceTimersByTime(SPOTLIGHT_MS - 1);
		expect(el.classList.contains(SPOTLIGHT_CLASS)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(el.classList.contains(SPOTLIGHT_CLASS)).toBe(false);
	});

	it('restarts the full duration when spotlighted again', () => {
		const el = fakeEl();
		spotlight(el);
		vi.advanceTimersByTime(SPOTLIGHT_MS - 100);
		spotlight(el);
		vi.advanceTimersByTime(200);
		expect(el.classList.contains(SPOTLIGHT_CLASS)).toBe(true);
		vi.advanceTimersByTime(SPOTLIGHT_MS);
		expect(el.classList.contains(SPOTLIGHT_CLASS)).toBe(false);
	});

	it('focuses the first input inside the target', () => {
		const input = { focus: vi.fn() };
		spotlight(fakeEl({ input }));
		expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('returns false when nothing carries that id', () => {
		expect(spotlight('missing', { root: rootWith({}) })).toBe(false);
	});
});
