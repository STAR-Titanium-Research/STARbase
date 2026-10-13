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
