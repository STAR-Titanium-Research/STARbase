import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The FAST plotting runs in two hosts (the Directus module and STARbase): it reaches the backend only
// through the FastHost's `api` and never builds host-specific URLs or opens windows itself.
const here = dirname(fileURLToPath(import.meta.url));
const sources = (p: string): string[] =>
	statSync(p).isFile() ? (/\.(ts|vue)$/.test(p) && !p.endsWith('.test.ts') ? [p] : []) : readdirSync(p).flatMap((n) => sources(join(p, n)));
const files = sources(here);
const rel = (f: string) => f.slice(here.length + 1).replace(/\\/g, '/');

describe('FAST plotting stays host-neutral', () => {
	it('finds the dashboard', () => {
		expect(files.some((f) => f.endsWith('FastDashboard.vue'))).toBe(true);
	});
	it('does not use the Directus extensions SDK', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toContain('@directus/extensions-sdk');
			expect(src, rel(f)).not.toMatch(/\buse(Api|Stores)\(/);
		}
	});
	it('builds no root-relative asset URLs and opens no windows', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			// api.get('/assets/<id>') is a request through the host's axios instance (it has the base URL); a bare
			// '/assets/...' string anywhere else is a browser URL that only works under Directus.
			expect(src, rel(f)).not.toMatch(/(?<!\.get\()['"`]\/assets\//);
			expect(src, rel(f)).not.toMatch(/window\.open\(/);
		}
	});
	it('keeps the Conform log modules pure: no Vue, no DOM globals, and /assets/ only in api.ts', () => {
		const conform = files.filter((f) => rel(f).startsWith('conform/'));
		const names = conform.map(rel);
		for (const n of ['api.ts', 'channels.ts', 'parse.ts', 'power.ts', 'normalise.ts', 'summary.ts', 'steps.ts', 'clock.ts', 'index.ts']) {
			expect(names, n).toContain(`conform/${n}`);
		}
		for (const f of conform) {
			const src = readFileSync(f, 'utf8');
			if (rel(f).includes('__fixtures__')) continue;   // test-only helpers read the fixture with node:fs
			expect(src, rel(f)).not.toMatch(/from ['"](vue|vue-router)['"]/);
			expect(src, rel(f)).not.toMatch(/\b(window|document|localStorage)\./);
			expect(src, rel(f)).not.toMatch(/from ['"]node:/);
			if (!rel(f).endsWith('api.ts')) expect(src, rel(f)).not.toContain('/assets/');
		}
	});
});
