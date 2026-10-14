import { describe, expect, it } from 'vitest';
import { luminance, PALETTE_EXPRESSIONS, parseCssColor } from './themePalette';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 4);

describe('parseCssColor', () => {
	it('reads legacy rgb() and rgba()', () => {
		const c = parseCssColor('rgb(255, 128, 0)')!;
		close(c.r, 1); close(c.g, 128 / 255); close(c.b, 0); close(c.a, 1);
		const d = parseCssColor('rgba(0, 0, 0, 0.5)')!;
		close(d.a, 0.5);
	});

	it('reads the space-separated rgb() form with a slash alpha', () => {
		const c = parseCssColor('rgb(10 20 30 / 0.25)')!;
		close(c.r, 10 / 255); close(c.g, 20 / 255); close(c.b, 30 / 255); close(c.a, 0.25);
		close(parseCssColor('rgb(10 20 30 / 50%)')!.a, 0.5);
	});

	it('reads color(srgb ...), which is what color-mix() computes to', () => {
		const c = parseCssColor('color(srgb 0.1 0.2 0.3)')!;
		close(c.r, 0.1); close(c.g, 0.2); close(c.b, 0.3); close(c.a, 1);
		close(parseCssColor('color(srgb 0.1 0.2 0.3 / 0.4)')!.a, 0.4);
	});

	it('reads hex', () => {
		const c = parseCssColor('#18222f')!;
		close(c.r, 0x18 / 255); close(c.b, 0x2f / 255);
		const s = parseCssColor('#fff')!;
		close(s.r, 1); close(s.g, 1);
		close(parseCssColor('#00000080')!.a, 128 / 255);
	});

	it('is case and space tolerant', () => {
		expect(parseCssColor('  RGB(1, 2, 3)  ')).not.toBeNull();
	});

	it('clamps out-of-range channels', () => {
		const c = parseCssColor('color(srgb 1.2 -0.1 0.5)')!;
		expect(c.r).toBe(1);
		expect(c.g).toBe(0);
	});

	it('returns null for forms it cannot read, and for junk', () => {
		for (const s of ['oklab(0.5 0.1 0.1)', 'color(display-p3 1 0 0)', 'red', '', 'rgb(1 2)', 'rgb(a b c)', '#12', '#12345']) {
			expect(parseCssColor(s), s).toBeNull();
		}
	});
});

describe('luminance', () => {
	it('is 0 for black, 1 for white, and orders greys', () => {
		close(luminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
		close(luminance({ r: 1, g: 1, b: 1, a: 1 }), 1);
		expect(luminance({ r: 0.2, g: 0.2, b: 0.2, a: 1 })).toBeLessThan(luminance({ r: 0.6, g: 0.6, b: 0.6, a: 1 }));
	});
});

describe('PALETTE_EXPRESSIONS', () => {
	it('use theme variables only, never a literal colour', () => {
		for (const [key, expr] of Object.entries(PALETTE_EXPRESSIONS)) {
			expect(expr, key).toContain('var(--');
			expect(expr, key).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsl/i);
		}
	});
});
