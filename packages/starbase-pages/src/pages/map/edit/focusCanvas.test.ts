import { describe, expect, it, vi } from 'vitest';
import { focusCanvas } from './focusCanvas';

interface Fake {
	dataset: Record<string, string>;
	focus: ReturnType<typeof vi.fn>;
	hasAttribute: (k: string) => boolean;
	setAttribute: (k: string, v: string) => void;
	attrs: Map<string, string>;
	querySelectorAll: () => Fake[];
}
const el = (dataset: Record<string, string> = {}, cards: Fake[] = []): Fake => {
	const attrs = new Map<string, string>();
	return {
		dataset,
		focus: vi.fn(),
		hasAttribute: (k: string) => attrs.has(k),
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		attrs,
		querySelectorAll: () => cards,
	};
};
const asEl = (e: unknown) => e as HTMLElement;

describe('focusCanvas', () => {
	it('focuses the card asked for', () => {
		const a = el({ id: 'a' });
		const b = el({ id: 'b' });
		focusCanvas(asEl(el({}, [a, b])), 'b');
		expect(b.focus).toHaveBeenCalledOnce();
		expect(a.focus).not.toHaveBeenCalled();
	});

	it('falls back to the first card, then to the canvas (made focusable)', () => {
		const a = el({ id: 'a' });
		focusCanvas(asEl(el({}, [a])), 'gone');
		expect(a.focus).toHaveBeenCalledOnce();
		const canvas = el();
		focusCanvas(asEl(canvas));
		expect(canvas.focus).toHaveBeenCalledOnce();
		expect(canvas.attrs.get('tabindex')).toBe('-1');
	});

	it('does nothing without a canvas', () => {
		expect(() => focusCanvas(null)).not.toThrow();
	});
});
