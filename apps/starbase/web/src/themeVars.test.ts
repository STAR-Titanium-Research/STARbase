import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every --theme-- variable the kit, the pages and the plotters read is one Directus defines. Outside
// Directus, theme.css must define each of them, in both schemes, or a panel goes transparent or a text
// goes black-on-black.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const ROOTS = ['packages/d1-ui/src', 'packages/starbase-pages/src', 'packages/force-plotting/src', 'packages/fast-plotting/src'];
const files = (p: string): string[] =>
	statSync(p).isFile() ? (/\.(vue|css|ts)$/.test(p) ? [p] : []) : readdirSync(p).filter((n) => n !== 'node_modules').flatMap((n) => files(join(p, n)));
const used = [...new Set(ROOTS.flatMap((r) => files(join(repo, r))).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/var\(\s*(--theme--[a-z0-9-]+)/g)].map((m) => m[1])))].sort();
const css = readFileSync(join(here, 'theme.css'), 'utf8');
const [light, dark] = css.split('@media (prefers-color-scheme: dark)');

// WCAG 2.x relative luminance and contrast ratio, for #rrggbb values.
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
	const n = parseInt(hex.slice(1), 16);
	return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string) => {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const darkValue = (name: string) => (dark ?? '').match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))?.[1] ?? '';

describe('dark scheme legibility', () => {
	it('the contrast helper is right (black on white is 21:1)', () => {
		expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
	});
	it('the primary colour is visible against the dark background (3:1)', () => {
		const [primary, background] = [darkValue('--theme--primary'), darkValue('--theme--background')];
		expect(primary).not.toBe('');
		expect(background).not.toBe('');
		expect(contrast(primary, background)).toBeGreaterThanOrEqual(3);
	});
	it('text on the dark primary reads (4.5:1)', () => {
		const [primary, fg] = [darkValue('--theme--primary'), darkValue('--theme--primary-foreground')];
		expect(fg).not.toBe('');
		expect(contrast(fg, primary)).toBeGreaterThanOrEqual(4.5);
	});
});

describe('STARbase buttons', () => {
	// --theme--foreground-inverted is #fff in both schemes (2.9:1 on the dark primary); --theme--primary-foreground
	// is the pairing VButton uses and the one the 4.5:1 test above checks.
	it('.sb-primary reads in --theme--primary-foreground on --theme--primary', () => {
		const styles = readFileSync(join(here, 'styles.css'), 'utf8');
		const rule = styles.match(/\.sb-primary\s*\{[^}]*\}/)?.[0] ?? '';
		expect(rule).not.toBe('');
		expect(rule).toMatch(/background:\s*var\(--theme--primary\)/);
		expect(rule).toMatch(/[^-]color:\s*var\(--theme--primary-foreground\)/);
	});
});

describe('theme.css', () => {
	it('finds the variables it is meant to check', () => {
		expect(used).toContain('--theme--primary');
		expect(used.length).toBeGreaterThan(15);
	});
	it('defines every --theme-- variable used, for light and for dark', () => {
		for (const name of used) {
			expect(light, `${name} (light)`).toContain(`${name}:`);
			expect(dark ?? '', `${name} (dark)`).toContain(`${name}:`);
		}
	});
});
