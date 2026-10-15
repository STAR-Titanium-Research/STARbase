import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_FIELDS, isReserved } from './reserved';

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = join(here, '..', '..', '..', '..', 'core', 'extensions', 'd1-build', 'index.js');

/** The endpoint's lists read as text (it is plain ESM JS in another package): `COMMON_RESERVED` and `RESERVED_FIELDS`. */
function serverLists(): Record<string, string[]> {
	const src = readFileSync(ENDPOINT, 'utf8');
	const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
	const common = src.match(/const COMMON_RESERVED = \[([\s\S]*?)\];/);
	const block = src.match(/export const RESERVED_FIELDS = \{([\s\S]*?)\n\};/);
	if (!common || !block) throw new Error(`RESERVED_FIELDS not found in ${ENDPOINT}`);
	const out: Record<string, string[]> = {};
	for (const m of block[1].matchAll(/(\w+): \[([\s\S]*?)\]/g)) {
		out[m[1]] = [...quoted(m[2]), ...(m[2].includes('...COMMON_RESERVED') ? quoted(common[1]) : [])];
	}
	return out;
}

describe('RESERVED_FIELDS', () => {
	const server = serverLists();

	it('reads all three kinds from the endpoint', () => {
		expect(Object.keys(server).sort()).toEqual(['operation', 'sample', 'test']);
		for (const list of Object.values(server)) expect(list.length).toBeGreaterThan(8);
	});

	it('holds every field d1-build refuses, for each kind', () => {
		for (const kind of ['sample', 'operation', 'test'] as const) {
			const missing = server[kind].filter((f) => !RESERVED_FIELDS[kind].includes(f));
			expect(missing, `${kind}: refused by d1-build, offered by the form`).toEqual([]);
		}
	});

	it('names the cases that were missed: a sample\'s status, a test\'s subject', () => {
		expect(isReserved('sample', 'current_status')).toBe(true);
		expect(isReserved('test', 'subject')).toBe(true);
		expect(isReserved('operation', 'current_status')).toBe(false);
	});
});
