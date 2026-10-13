import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A record link written as a raw `<router-link :to="recordRoute(...)">` in a Directus extension
// yields '/home/<page>/<id>', a route of the Home module that headless phase 1 deleted: the link
// goes dead. Links to records go through the kit's RecordLink / AppLink, which resolve through
// directusLinks (a permanent link in a new tab for the five record pages).
const here = dirname(fileURLToPath(import.meta.url));
const extensions = join(here, '..', '..', '..', 'core', 'extensions');

function vueFiles(path: string): string[] {
	if (!existsSync(path)) return [];
	if (statSync(path).isFile()) return path.endsWith('.vue') ? [path] : [];
	return readdirSync(path).flatMap((name) => vueFiles(join(path, name)));
}

const files = readdirSync(extensions).flatMap((ext) => vueFiles(join(extensions, ext, 'src')));

describe('extensions do not bypass the link resolver for records', () => {
	it('finds the extension sources it is meant to check', () => {
		expect(files.some((f) => f.replace(/\\/g, '/').endsWith('d1-lab-dashboard/src/views/SampleDashboard.vue'))).toBe(true);
	});

	it('never feeds recordRoute() to a raw router-link', () => {
		const bad: string[] = [];
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			if (/<router-link\b[^>]*:to="recordRoute\(/.test(src)) bad.push(f.slice(extensions.length + 1).replace(/\\/g, '/'));
		}
		expect(bad).toEqual([]);
	});
});
