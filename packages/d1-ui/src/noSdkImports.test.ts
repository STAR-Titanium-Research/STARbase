import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Explorer is meant to leave Directus: these folders (and the host contract) must stay free of
// the Directus extension SDK, so the host is the only thing that changes when it does.
const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = '@directus/extensions-sdk';

function sources(path: string): string[] {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return [];
	}
	if (stat.isFile()) return /\.(ts|vue)$/.test(path) ? [path] : [];
	return readdirSync(path).flatMap((name) => sources(join(path, name)));
}

describe('Explorer sources stay host-neutral', () => {
	const files = ['nav', 'index', 'finder'].flatMap((d) => sources(join(here, d))).concat(sources(join(here, 'host.ts')));

	it('finds the files it is meant to check', () => {
		expect(files.some((f) => f.endsWith('navConfig.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('indexConfig.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('host.ts'))).toBe(true);
	});

	it('does not mention the Directus extensions SDK', () => {
		for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(FORBIDDEN);
	});
});
