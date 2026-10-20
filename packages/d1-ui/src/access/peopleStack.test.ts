import { describe, expect, it } from 'vitest';
import type { AccessEntry, AccessList, TeamAccess } from './accessModel';
import { FADE_OPACITIES, peopleStack } from './peopleStack';

const entry = (name: string, role: string, over: Partial<AccessEntry> = {}): AccessEntry => ({
	person_id: `p-${name}`, name, role, source: 'access', can_sign_in: true, added_by: null, added_at: null, blocked_by: null, ...over,
});
const team = (name: string, role: string): TeamAccess => ({
	team_access_id: `ta-${name}`, team_id: `t-${name}`, name, color: 'teal', logo: null, member_count: 4, role,
	trust_new_members: false, waiting: 0, declined: 0,
});
const list = (over: Partial<AccessList> = {}): AccessList => ({
	restricted: false,
	owner: { person_id: 'pi', name: 'Dennis Premoli', can_sign_in: true },
	project_pi: null,
	can_manage: false,
	entries: [],
	teams: [],
	...over,
});

describe('peopleStack', () => {
	it('puts the PI first, then investigators, edit, view, with people before teams in a level', () => {
		const s = peopleStack(list({
			entries: [entry('Zed Zane', 'view'), entry('Amy Ash', 'view'), entry('Ivy Ito', 'investigator'), entry('Eli Eng', 'edit')],
			teams: [team('Additive', 'view'), team('Materials', 'investigator')],
		}));
		expect(s.faces.map((f) => f.label)).toEqual([
			'Dennis Premoli: Principal investigator',
			'Ivy Ito: Secondary investigator',
			'Materials: Secondary investigator',
			'Eli Eng: Can edit',
			'Amy Ash: Can view',
			'Zed Zane: Can view',
			'Additive: Can view',
		]);
		expect(s.faces[0]).toMatchObject({ pi: true, team: false, initials: 'DP', opacity: 1 });
		expect(s.faces[2]).toMatchObject({ team: true, initials: '', pi: false });
	});

	it('counts the line: PI, investigators (people and teams), the rest', () => {
		const s = peopleStack(list({
			entries: [entry('Ivy Ito', 'investigator'), entry('Eli Eng', 'edit'), entry('Amy Ash', 'view')],
			teams: [team('Materials', 'investigator'), team('Additive', 'view')],
		}));
		expect(s).toMatchObject({ total: 6, investigators: 2, more: 3, shown: 6 });
	});

	it('shows six in full, then three fading, and counts everyone', () => {
		const entries = Array.from({ length: 12 }, (_, i) => entry(`Person ${String(i).padStart(2, '0')}`, 'view'));
		const s = peopleStack(list({ entries }));
		expect(s.total).toBe(13);
		expect(s.faces).toHaveLength(9);
		expect(s.faces.slice(0, 6).map((f) => f.opacity)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(s.faces.slice(6).map((f) => f.opacity)).toEqual([...FADE_OPACITIES]);
		expect(s.more).toBe(12);
	});

	it('has no fading faces for a short list', () => {
		const s = peopleStack(list({ entries: [entry('Amy Ash', 'view')] }));
		expect(s.faces.map((f) => f.opacity)).toEqual([1, 1]);
	});

	it('lists the PI once even when the entries repeat them', () => {
		const s = peopleStack(list({ entries: [entry('Dennis Premoli', 'investigator', { person_id: 'pi' }), entry('Amy Ash', 'view')] }));
		expect(s.faces.map((f) => f.key)).toEqual(['person:pi', 'person:p-Amy Ash']);
		expect(s).toMatchObject({ total: 2, investigators: 0, more: 1 });
	});

	it('keeps an entry with no People row, and a team that owns the record', () => {
		const s = peopleStack(list({
			owner: { kind: 'team', team_id: 't-Additive', name: 'Additive', color: 'teal', logo: null, managers: [] },
			entries: [entry('Old Co-owner', 'edit', { person_id: null, source: 'co_owner' })],
			teams: [team('Additive', 'edit')],
		}));
		expect(s.faces.map((f) => [f.label, f.team, f.pi])).toEqual([
			['Additive: Principal investigator', true, true],
			['Old Co-owner: Can edit', false, false],
		]);
		expect(s.total).toBe(2);
	});

	it('falls back to the PI alone, with no counts, when the list could not be read', () => {
		const s = peopleStack(null, 'Dennis Premoli');
		expect(s.faces).toEqual([
			{ key: 'pi', label: 'Dennis Premoli: Principal investigator', initials: 'DP', team: false, pi: true, opacity: 1 },
		]);
		expect(s).toMatchObject({ total: 1, investigators: 0, more: 0 });
	});

	it('is empty with no list and no PI name', () => {
		expect(peopleStack(null, '')).toMatchObject({ faces: [], total: 0, more: 0 });
	});

	it('uses the project PI name when the owner row has none', () => {
		const s = peopleStack(list({ owner: { person_id: 'pi', name: '', can_sign_in: true } }), 'Dennis Premoli');
		expect(s.faces[0].label).toBe('Dennis Premoli: Principal investigator');
	});
});
