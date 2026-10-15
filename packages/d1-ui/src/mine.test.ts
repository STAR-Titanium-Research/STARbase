import { describe, expect, it } from 'vitest';
import {
	campaignsMine, coOwnedByMe, failedTests, forceErrorOnMyOperations, forcePendingOperations, ownedByMe, ownedByTeams, ownerlessSamples, projectInvestigatorFilter,
	projectsMine, samplesMine, withMyTeams,
} from './mine';

// A record a team owns (owner_team_id) is the work of every member of that team: the member ids come from /items/team_members.
describe('records of my teams', () => {
	it('names the teams I belong to by id, and is nothing when I belong to none', () => {
		expect(ownedByTeams(['t1', 't2'])).toEqual({ owner_team_id: { _in: ['t1', 't2'] } });
		expect(ownedByTeams([])).toBeNull();
	});

	it('widens a "mine" filter with the team clause, and leaves it alone without teams', () => {
		expect(withMyTeams(ownedByMe, [])).toBe(ownedByMe);
		expect(withMyTeams(ownedByMe, ['t1'])).toEqual({ _or: [ownedByMe, { owner_team_id: { _in: ['t1'] } }] });
		// an _or of its own is extended, not nested
		expect(withMyTeams(samplesMine, ['t1'])).toEqual({ _or: [ownedByMe, coOwnedByMe, { owner_team_id: { _in: ['t1'] } }] });
	});

	it('are legal filters', () => {
		for (const f of [withMyTeams(ownedByMe, ['t1', 't2']), withMyTeams(samplesMine, ['t1']), ownedByTeams(['t1'])]) expect(filterProblems(f)).toEqual([]);
	});

	it('leaves the exported samplesMine and campaignsMine as the smoke test carries them', () => {
		expect(JSON.stringify(samplesMine)).not.toContain('owner_team_id');
		expect(campaignsMine).toBe(ownedByMe);
	});
});

describe('ownerlessSamples', () => {
	it('has neither a person nor a team as owner', () => {
		expect(ownerlessSamples).toEqual({ _and: [{ owner_person_id: { _null: true } }, { owner_team_id: { _null: true } }] });
	});
});

describe('projectInvestigatorFilter', () => {
	it('is "this project" AND "I am its PI or an investigator"', () => {
		expect(projectInvestigatorFilter('p1')).toEqual({ _and: [{ project_id: { _eq: 'p1' } }, projectsMine] });
		const mine = JSON.stringify(projectsMine);
		expect(mine).toContain('principal_investigator_person');
		expect(mine).toContain('secondary_investigators');
		expect(mine).toContain('$CURRENT_USER');
	});
});

// The Directus constraints (spec section 3, "Directus constraints") the Explorer's own filters must respect, as a walker.
// A filter node is an object. Logical keys (_and, _or) carry arrays of nodes; any other key is a field, and its value is
// either a comparison ({_eq: ...}), a nested node (a relation hop) or { _some: <body> } (a to-many alias).
const LOGICAL = new Set(['_and', '_or']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Returns every way the filter breaks a rule; an empty list is a legal filter. */
function filterProblems(node: unknown, atRoot = true, path = '$'): string[] {
	if (!isObject(node)) return [];
	const problems: string[] = [];
	const keys = Object.keys(node);
	const fieldKeys = keys.filter((k) => !k.startsWith('_'));
	// A relation key is read by its first key only: a second key beside it is silently dropped.
	if (fieldKeys.length > 0 && keys.length > 1) problems.push(`${path}: a field key has sibling keys (${keys.join(', ')}); only the first would be read`);
	for (const key of keys) {
		const value = node[key];
		if (LOGICAL.has(key)) {
			if (Array.isArray(value)) value.forEach((item, i) => problems.push(...filterProblems(item, atRoot, `${path}.${key}[${i}]`)));
			continue;
		}
		if (key === '_some') {
			problems.push(`${path}: _some outside a field`);
			continue;
		}
		if (key.startsWith('_')) continue; // a comparison operator
		if (isObject(value) && '_some' in value) {
			if (!atRoot) problems.push(`${path}.${key}: _some below the root (only a top-level alias may use it)`);
			if (Object.keys(value).length !== 1) problems.push(`${path}.${key}: a _some with other keys beside it`);
			// the body must be one plain chain: a single key at every level, no _and / _or, no inner _some
			let body: unknown = value._some;
			while (isObject(body)) {
				const bodyKeys = Object.keys(body);
				if (bodyKeys.length !== 1) { problems.push(`${path}.${key}._some: the body has ${bodyKeys.length} keys, it must be one plain chain`); break; }
				if (LOGICAL.has(bodyKeys[0])) { problems.push(`${path}.${key}._some: the body holds ${bodyKeys[0]}`); break; }
				if (bodyKeys[0] === '_some') { problems.push(`${path}.${key}._some: a _some inside a _some`); break; }
				body = body[bodyKeys[0]];
			}
			continue;
		}
		problems.push(...filterProblems(value, false, `${path}.${key}`));
	}
	return problems;
}

describe('the legality walker', () => {
	it('accepts a chain, an _and of two bare paths, and a top-level _some chain', () => {
		expect(filterProblems({ a: { b: { _eq: 1 } } })).toEqual([]);
		expect(filterProblems({ _and: [{ access: { person_id: { user_id: { _eq: 'u' } } } }, { access: { role: { _eq: 'edit' } } }] })).toEqual([]);
		expect(filterProblems({ _or: [{ co_owners: { _some: { user_id: { _eq: 'u' } } } }] })).toEqual([]);
	});
	it('refuses a sibling key beside a relation key', () => {
		expect(filterProblems({ access: { person_id: { _eq: 'p' }, role: { _eq: 'edit' } } })).not.toEqual([]);
	});
	it('refuses a _some with two conditions, a logical body, and a _some below the root', () => {
		expect(filterProblems({ access: { _some: { person_id: { _eq: 'p' }, role: { _eq: 'edit' } } } })).not.toEqual([]);
		expect(filterProblems({ access: { _some: { _and: [{ role: { _eq: 'edit' } }] } } })).not.toEqual([]);
		expect(filterProblems({ sample_id: { access: { _some: { role: { _eq: 'edit' } } } } })).not.toEqual([]);
	});
});

describe('mine filters', () => {
	it('use the ADR-0011 involvement paths with $CURRENT_USER', () => {
		expect(ownedByMe).toEqual({ owner_person_id: { user_id: { _eq: '$CURRENT_USER' } } });
		expect(samplesMine).toEqual({ _or: [ownedByMe, coOwnedByMe] });
		expect(forceErrorOnMyOperations).toEqual({
			_and: [ownedByMe, { force_analyses: { _some: { status: { _eq: 'error' } } } }],
		});
	});

	it('count a person listed with role edit as a co-owner, an AND of two bare paths through the same alias', () => {
		const accessRow = {
			_and: [{ access: { person_id: { user_id: { _eq: '$CURRENT_USER' } } } }, { access: { role: { _eq: 'edit' } } }],
		};
		expect(coOwnedByMe).toEqual({ _or: [{ co_owners: { _some: { user_id: { _eq: '$CURRENT_USER' } } } }, accessRow] });
	});

	it('count a project_access row with role investigator as a secondary investigator', () => {
		const accessRow = {
			_and: [{ access: { person_id: { user_id: { _eq: '$CURRENT_USER' } } } }, { access: { role: { _eq: 'investigator' } } }],
		};
		expect(projectsMine).toEqual({
			_or: [
				{ principal_investigator_person: { user_id: { _eq: '$CURRENT_USER' } } },
				{ secondary_investigators: { _some: { user_id: { _eq: '$CURRENT_USER' } } } },
				accessRow,
			],
		});
	});

	it('are all in the legal form (no sibling key beside a relation key, no _some with two conditions, no _some below the root)', () => {
		const all = {
			ownedByMe, coOwnedByMe, samplesMine, projectsMine, campaignsMine, forceErrorOnMyOperations, forcePendingOperations, failedTests, ownerlessSamples,
			investigatorOfOne: projectInvestigatorFilter('p1'),
		};
		for (const [name, filter] of Object.entries(all)) expect(filterProblems(filter), name).toEqual([]);
	});
});

// scripts/dev/directus_smoke.mjs sends samplesMine and projectsMine to a real Directus (the Lab Member must get 200 and the right ids). It
// cannot import this TypeScript, so it carries the two filters as JSON literals; they must stay equal to the ones Home sends.
describe('the smoke test sends the filters Home sends', () => {
	it('carries samplesMine and projectsMine verbatim', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const smoke = readFileSync(fileURLToPath(new URL('../../../scripts/dev/directus_smoke.mjs', import.meta.url)), 'utf8');
		const literal = (name: string) => {
			const start = `const ${name} = JSON.parse('`;
			const at = smoke.indexOf(start);
			expect(at, `${name} is in the smoke test`).toBeGreaterThanOrEqual(0);
			const from = at + start.length;
			return JSON.parse(smoke.slice(from, smoke.indexOf(`');`, from)));
		};
		expect(literal('SAMPLES_MINE')).toEqual(samplesMine);
		expect(literal('PROJECTS_MINE')).toEqual(projectsMine);
	});
});
