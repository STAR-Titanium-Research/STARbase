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

// The whole kit is host-neutral: STARbase renders it outside Directus. Directus is reached only
// through the host (host.ts) and links go through links.ts / AppLink.
describe('the kit stays host-neutral', () => {
	const files = sources(here).filter((f) => !f.endsWith('.test.ts'));
	const rel = (f: string) => f.slice(here.length + 1).replace(/\\/g, '/');

	it('finds the files it is meant to check', () => {
		expect(files.some((f) => f.endsWith('navConfig.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('EditDrawer.vue'))).toBe(true);
	});

	it('does not use the Directus extensions SDK', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toContain(FORBIDDEN);
			expect(src, rel(f)).not.toMatch(/\buse(Api|Stores)\(/);
		}
	});

	it('builds links and asset URLs only through links.ts', () => {
		const allowed = ['links.ts', 'components/AppLink.vue'];
		for (const f of files.filter((f) => !allowed.includes(rel(f)))) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toMatch(/<router-link\b|['"`]router-link['"`]/);
			expect(src, rel(f)).not.toMatch(/['"`]\/assets\//);
			expect(src, rel(f)).not.toMatch(/window\.open\(/);
		}
	});
});

// The "Who has access" dialog (access/ and its two components) talks to the host's api and never to the SDK.
describe('access dialog stays host-neutral', () => {
	const files = [
		...sources(join(here, 'access')).filter((f) => !f.endsWith('.test.ts')),
		join(here, 'components', 'AccessDialog.vue'),
		join(here, 'components', 'AccessPersonPicker.vue'),
		...sources(join(here, 'teams')).filter((f) => !f.endsWith('.test.ts')),
		join(here, 'components', 'AccessTeamRow.vue'),
	];

	it('finds the files it is meant to check', () => {
		expect(files.some((f) => f.endsWith('accessModel.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('useAccess.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('AccessDialog.vue'))).toBe(true);
		expect(files.some((f) => f.endsWith('AccessPersonPicker.vue'))).toBe(true);
	});

	it('does not mention the Directus extensions SDK', () => {
		for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(FORBIDDEN);
	});
});

// The record-page kit (rail layout, rail, fact list, contents) is meant to run outside the Data
// Studio too: no Directus components (`<v-icon>`, `<v-button>`: the page passes icons and buttons in
// through slots) and no extensions SDK.
describe('record-page kit stays host-neutral', () => {
	const names = ['RecordLayout', 'RecordRail', 'FactList', 'PageContents'];
	const files = names.map((n) => join(here, 'components', `${n}.vue`));
	// Every module of record/ (the pure ones the kit and the pages share), tests left out.
	const modules = readdirSync(join(here, 'record'))
		.filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
		.map((n) => join(here, 'record', n));

	it('has the four components', () => {
		for (const f of files) expect(statSync(f).isFile(), f).toBe(true);
	});

	it('uses no Directus global component tags', () => {
		for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/<v-[a-z]/);
	});

	it('does not mention the Directus extensions SDK', () => {
		for (const f of [...files, ...modules]) expect(readFileSync(f, 'utf8'), f).not.toContain(FORBIDDEN);
	});
});
