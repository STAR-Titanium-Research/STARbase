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
});
