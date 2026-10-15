import { describe, expect, it } from 'vitest';
import { ATTENTION_LABELS, applyList, chipCounts, groupOf, groupPeople, parseListState, toQuery, type ListState, type PeopleRow, type PersonTeam } from './peopleQuery';

const DEFAULT: ListState = { view: 'people', chip: 'all', role: 'any', team: 'any', sort: 'name', q: '', attn: null, person: null };
const team = (id: string, over: Partial<PersonTeam> = {}): PersonTeam => ({ team_id: id, name: `Team ${id}`, color: 'teal', logo: null, is_manager: false, ...over });
const state = (over: Partial<ListState> = {}): ListState => ({ ...DEFAULT, ...over });

type Over = Partial<PeopleRow> & { signedIn?: string | null; role?: string | null };
const person = (id: string, over: Over = {}): PeopleRow => {
	const { signedIn, role, ...rest } = over;
	const hasLogin = signedIn !== undefined || role !== undefined;
	return {
		kind: 'person',
		person_id: id,
		full_name: id,
		email: `${id.toLowerCase()}@lab.example`,
		is_researcher: true,
		is_operator: false,
		active: true,
		notes: null,
		user_id: hasLogin ? `u-${id}` : null,
		login: hasLogin ? { status: 'active', role_id: role ?? 'r-member', role_name: 'Lab Member', last_access: signedIn ?? null, email: null } : null,
		attention: [],
		...rest,
	};
};
const loginRow = (userId: string, email: string): PeopleRow => ({
	kind: 'login',
	person_id: null,
	full_name: email,
	email,
	is_researcher: false,
	is_operator: false,
	active: true,
	notes: null,
	user_id: userId,
	login: { status: 'active', role_id: 'r-member', role_name: 'Lab Member', last_access: null, email },
	attention: ['login_without_person'],
});
const ids = (rows: PeopleRow[]) => rows.map((r) => r.person_id ?? r.user_id);

describe('list state in the URL', () => {
	it('default state serialises to {}', () => {
		expect(toQuery(DEFAULT)).toEqual({});
		expect(parseListState({})).toEqual(DEFAULT);
	});

	it('round-trips every non-default field', () => {
		const s: ListState = { view: 'teams', chip: 'operators', role: 'r-admin', team: 't-1', sort: 'last', q: 'ada', attn: 'missing_email', person: 'p-1' };
		expect(toQuery(s)).toEqual({ view: 'teams', f: 'operators', role: 'r-admin', team: 't-1', sort: 'last', q: 'ada', attn: 'missing_email', person: 'p-1' });
		expect(parseListState(toQuery(s))).toEqual(s);
		for (const chip of ['researchers', 'operators', 'nologin', 'former'] as const) expect(parseListState(toQuery(state({ chip })))).toEqual(state({ chip }));
		expect(parseListState(toQuery(state({ role: 'none' })))).toEqual(state({ role: 'none' }));
		expect(parseListState(toQuery(state({ sort: 'added' })))).toEqual(state({ sort: 'added' }));
		expect(parseListState(toQuery(state({ team: 't-9' })))).toEqual(state({ team: 't-9' }));
		expect(parseListState({ team: 't-9' }).team).toBe('t-9');
		expect(parseListState({ team: '' }).team).toBe('any');
	});

	it('unknown chip falls back to all', () => {
		expect(parseListState({ view: 'teams' }).view).toBe('teams');
		expect(parseListState({ view: 'wizards' }).view).toBe('people');
		expect(toQuery(state({ view: 'teams' }))).toEqual({ view: 'teams' });
		expect(parseListState(toQuery(state({ view: 'teams' })))).toEqual(state({ view: 'teams' }));
		expect(parseListState({ f: 'wizards' }).chip).toBe('all');
		expect(parseListState({ f: 7 }).chip).toBe('all');
		expect(parseListState({ sort: 'size' }).sort).toBe('name');
		expect(parseListState({ role: '' })).toEqual(DEFAULT);
		expect(parseListState({ f: ['former', 'nologin'] }).chip).toBe('former');
	});
});

describe('applyList', () => {
	it('former chip shows only active=false', () => {
		const rows = [person('Ann'), person('Bo', { active: false }), person('Cy', { active: false, signedIn: null }), loginRow('u-9', 'x@y.z')];
		expect(ids(applyList(rows, state({ chip: 'former' })))).toEqual(['Bo', 'Cy']);
	});

	it('nologin chip shows persons without a login, never login rows', () => {
		const rows = [person('Ann'), person('Bo', { signedIn: null }), person('Cy'), loginRow('u-9', 'x@y.z')];
		expect(ids(applyList(rows, state({ chip: 'nologin' })))).toEqual(['Ann', 'Cy']);
		expect(ids(applyList(rows, state({ chip: 'nologin', attn: 'login_without_person' })))).toEqual(['u-9']);
	});

	it('researchers and operators chips use the role flags', () => {
		const rows = [person('Ann'), person('Bo', { is_researcher: false, is_operator: true }), loginRow('u-9', 'x@y.z')];
		expect(ids(applyList(rows, state({ chip: 'researchers' })))).toEqual(['Ann']);
		expect(ids(applyList(rows, state({ chip: 'operators' })))).toEqual(['Bo']);
	});

	it('role none = persons with no login', () => {
		const rows = [person('Ann'), person('Bo', { signedIn: null, role: 'r-admin' }), person('Cy', { role: 'r-member' }), loginRow('u-9', 'x@y.z')];
		expect(ids(applyList(rows, state({ role: 'none' })))).toEqual(['Ann']);
		expect(ids(applyList(rows, state({ role: 'r-admin' })))).toEqual(['Bo']);
		expect(ids(applyList(rows, state({ role: 'any' })))).toEqual(['Ann', 'Bo', 'Cy', 'u-9']);
	});

	it('sort last puts never-signed-in last', () => {
		const rows = [
			person('Ann'),
			person('Bo', { signedIn: '2026-09-01T10:00:00.000Z' }),
			person('Cy', { signedIn: null }),
			person('Di', { signedIn: '2026-10-01T10:00:00.000Z' }),
		];
		expect(ids(applyList(rows, state({ sort: 'last' })))).toEqual(['Di', 'Bo', 'Ann', 'Cy']);
	});

	it('sort added puts the newest first and rows without a date last', () => {
		const rows = [person('Ann'), person('Bo', { created_at: '2026-01-01T00:00:00Z' }), person('Cy', { created_at: '2026-06-01T00:00:00Z' })];
		expect(ids(applyList(rows, state({ sort: 'added' })))).toEqual(['Cy', 'Bo', 'Ann']);
	});

	it('sort name is case-insensitive and does not change the input', () => {
		const rows = [person('bo'), person('Ann'), person('Cy')];
		expect(ids(applyList(rows, state()))).toEqual(['Ann', 'bo', 'Cy']);
		expect(ids(rows)).toEqual(['bo', 'Ann', 'Cy']);
	});

	it('search matches name and email case-insensitively', () => {
		const rows = [person('Ada Lovelace', { email: 'ada@lab.example' }), person('Bo', { email: 'LOVE@elsewhere.org' }), person('Cy')];
		expect(ids(applyList(rows, state({ q: 'LOVE' })))).toEqual(['Ada Lovelace', 'Bo']);
		expect(ids(applyList(rows, state({ q: ' ada@LAB ' })))).toEqual(['Ada Lovelace']);
		expect(ids(applyList(rows, state({ q: 'zzz' })))).toEqual([]);
	});

	it('attn filters to rows whose attention includes the key, and login_without_person shows login rows', () => {
		const rows = [
			person('Ann', { attention: ['missing_email', 'possible_duplicate'] }),
			person('Bo', { attention: ['possible_duplicate'] }),
			person('Cy'),
			loginRow('u-9', 'x@y.z'),
		];
		expect(ids(applyList(rows, state({ attn: 'possible_duplicate' })))).toEqual(['Ann', 'Bo']);
		expect(ids(applyList(rows, state({ attn: 'missing_email' })))).toEqual(['Ann']);
		expect(ids(applyList(rows, state({ attn: 'login_without_person' })))).toEqual(['u-9']);
	});

	it('login rows are shown for the all chip and no other', () => {
		const rows = [person('Ann'), loginRow('u-9', 'x@y.z')];
		expect(ids(applyList(rows, state()))).toEqual(['Ann', 'u-9']);
		for (const chip of ['researchers', 'operators', 'nologin', 'former'] as const) expect(ids(applyList(rows, state({ chip })))).not.toContain('u-9');
	});
});

describe('Former people go last', () => {
	const rows = [person('Zed', { active: false, signedIn: '2026-10-10T00:00:00Z' }), person('Amy', { active: false, signedIn: '2026-01-01T00:00:00Z' }), person('Bob', { signedIn: '2026-02-01T00:00:00Z' }), person('Cat', { signedIn: '2026-09-01T00:00:00Z' })];
	it('by name: the active first, then the Former, each in name order', () => {
		expect(applyList(rows, state()).map((r) => r.person_id)).toEqual(['Bob', 'Cat', 'Amy', 'Zed']);
	});
	it('by last sign-in: the chosen sort still applies inside each group', () => {
		expect(applyList(rows, state({ sort: 'last' })).map((r) => r.person_id)).toEqual(['Cat', 'Bob', 'Zed', 'Amy']);
	});
	it('a login without a person is not Former', () => {
		expect(applyList([person('Amy', { active: false }), loginRow('u1', 'z@lab.example')], state()).map((r) => r.kind)).toEqual(['login', 'person']);
	});
});

describe('groupPeople', () => {
	const admin = (id: string, over: Over = {}) => ({ ...person(id, { signedIn: null, ...over }), login: { status: 'active', role_id: 'r-a', role_name: 'Administrator', last_access: null, email: null } });
	const labAdmin = (id: string) => ({ ...admin(id), login: { ...admin(id).login!, role_name: 'Lab Admin' } });
	const operator = (id: string, over: Over = {}) => person(id, { is_researcher: false, is_operator: true, ...over });

	it('puts each person in the first group that matches: Admins, Users, Operators, then Former', () => {
		const groups = groupPeople([
			admin('Ada'), labAdmin('Lee'), person('Una', { signedIn: null }), person('Rex'), operator('Olly'), operator('Ned', { signedIn: null }),
			person('Gus', { is_researcher: false, is_operator: true, signedIn: null }),
		]);
		expect(groups.map((g) => [g.id, ids(g.rows)])).toEqual([
			['admins', ['Ada', 'Lee']],
			['users', ['Una', 'Rex', 'Ned', 'Gus']], // a login, or a researcher without one
			['operators', ['Olly']], // an operator who is not a researcher and has no login
		]);
	});

	it('a researcher who is also an operator, without a login, is a User', () => {
		expect(groupOf(person('Both', { is_operator: true }))).toBe('users');
	});

	it('Former overrides every other group, an Administrator and an operator included', () => {
		const groups = groupPeople([admin('Ada', { active: false }), operator('Olly', { active: false }), person('Una', { active: false, signedIn: null }), person('Ann')]);
		expect(groups.map((g) => [g.id, ids(g.rows)])).toEqual([['users', ['Ann']], ['former', ['Ada', 'Olly', 'Una']]]);
	});

	it('a login without a person is a User, or an Admin when its role is', () => {
		const asAdmin = { ...loginRow('u2', 'boss@lab.example'), login: { ...loginRow('u2', 'x').login!, role_name: 'Lab Admin' } };
		const groups = groupPeople([loginRow('u1', 'who@lab.example'), asAdmin]);
		expect(groups.map((g) => [g.id, ids(g.rows)])).toEqual([['admins', ['u2']], ['users', ['u1']]]);
	});

	it('hides the empty groups, and gives none for no rows', () => {
		expect(groupPeople([operator('Olly')]).map((g) => g.id)).toEqual(['operators']);
		expect(groupPeople([])).toEqual([]);
	});

	it('keeps the order it was given inside each group (the chosen sort holds), and each group has a label', () => {
		const sorted = applyList([person('Zoe', { signedIn: null }), person('Abe', { signedIn: null }), admin('Mo'), admin('Al')], state());
		const groups = groupPeople(sorted);
		expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([['Admins', ['Al', 'Mo']], ['Users', ['Abe', 'Zoe']]]);
	});

	it('is a partition: every row is in exactly one group', () => {
		const rows = [admin('A'), person('B', { signedIn: null }), operator('C'), person('D', { active: false }), loginRow('u1', 'l@x.y')];
		expect(groupPeople(rows).flatMap((g) => g.rows).length).toBe(rows.length);
	});
});

describe('the team filter', () => {
	it('keeps the people whose teams include the team, and nobody else', () => {
		const rows = [
			person('Ann', { teams: [team('t1'), team('t2')] }),
			person('Bo', { teams: [team('t2')] }),
			person('Cy', { teams: [] }),
			person('Di'), // a row with no teams at all
			loginRow('u-9', 'x@y.z'),
		];
		expect(ids(applyList(rows, state({ team: 't2' })))).toEqual(['Ann', 'Bo']);
		expect(ids(applyList(rows, state({ team: 't1' })))).toEqual(['Ann']);
		expect(ids(applyList(rows, state({ team: 'nope' })))).toEqual([]);
		expect(ids(applyList(rows, state({ team: 'any' })))).toEqual(['Ann', 'Bo', 'Cy', 'Di', 'u-9']);
	});

	it('combines with the chips and the role', () => {
		const rows = [
			person('Ann', { teams: [team('t1')], signedIn: null, role: 'r-a' }),
			person('Bo', { teams: [team('t1')], active: false }),
			person('Cy', { teams: [team('t2')], active: false }),
		];
		expect(ids(applyList(rows, state({ team: 't1', chip: 'former' })))).toEqual(['Bo']);
		expect(ids(applyList(rows, state({ team: 't1', role: 'r-a' })))).toEqual(['Ann']);
	});
});

describe('chipCounts', () => {
	it('chipCounts counts persons only', () => {
		const rows = [
			person('Ann'),
			person('Bo', { is_researcher: false, is_operator: true, signedIn: null }),
			person('Cy', { active: false, is_operator: true }),
			loginRow('u-9', 'x@y.z'),
		];
		expect(chipCounts(rows)).toEqual({ all: 3, researchers: 2, operators: 2, nologin: 2, former: 1 });
	});
});

describe('ATTENTION_LABELS', () => {
	it('ATTENTION_LABELS pluralise', () => {
		const L = ATTENTION_LABELS;
		expect(Object.keys(L).sort()).toEqual(
			['former_in_team', 'former_login_active', 'invite_not_accepted', 'login_without_person', 'missing_email', 'possible_duplicate', 'suspended_owns_records'],
		);
		expect(L.login_without_person(3)).toBe('3 logins with no person');
		expect(L.login_without_person(1)).toBe('1 login with no person');
		expect(L.invite_not_accepted(1)).toBe('1 invite not accepted');
		expect(L.invite_not_accepted(2)).toBe('2 invites not accepted');
		expect(L.missing_email(2)).toBe('2 people missing an email');
		expect(L.missing_email(1)).toBe('1 person missing an email');
		expect(L.possible_duplicate(4)).toBe('4 possible duplicates');
		expect(L.possible_duplicate(1)).toBe('1 possible duplicate');
		expect(L.former_login_active(1)).toBe('1 Former person whose login is still active');
		expect(L.former_login_active(2)).toBe('2 Former people whose logins are still active');
		expect(L.suspended_owns_records(1)).toBe('1 Suspended login that still owns records');
		expect(L.suspended_owns_records(2)).toBe('2 Suspended logins that still own records');
		expect(L.former_in_team(1)).toBe('1 Former person still in a team');
		expect(L.former_in_team(3)).toBe('3 Former people still in a team');
	});
});
