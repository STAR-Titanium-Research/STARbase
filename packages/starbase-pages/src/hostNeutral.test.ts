import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// STARbase's pages run in two hosts (the Directus Home module and apps/starbase/web): they reach
// Directus only through the Explorer host and build links only through @d1/ui's links.ts / AppLink.
const here = dirname(fileURLToPath(import.meta.url));
const sources = (p: string): string[] =>
	statSync(p).isFile() ? (/\.(ts|vue)$/.test(p) && !p.endsWith('.test.ts') ? [p] : []) : readdirSync(p).flatMap((n) => sources(join(p, n)));
const files = sources(here);
const rel = (f: string) => f.slice(here.length + 1).replace(/\\/g, '/');

describe('STARbase pages stay host-neutral', () => {
	it('finds the pages', () => {
		expect(files.some((f) => f.endsWith('SamplePage.vue'))).toBe(true);
	});
	it('do not use the Directus extensions SDK', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toContain('@directus/extensions-sdk');
			expect(src, rel(f)).not.toMatch(/\buse(Api|Stores)\(/);
		}
	});
	it('build links and asset URLs only through @d1/ui', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toMatch(/<router-link\b|['"`]router-link['"`]/);
			expect(src, rel(f)).not.toMatch(/['"`]\/assets\//);
			expect(src, rel(f)).not.toMatch(/window\.open\(/);
			expect(src, rel(f)).not.toMatch(/\brouter\.push\(/);
		}
	});
});
