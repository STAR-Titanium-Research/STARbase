import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { PeopleApiError, invite, personAttention, listTeamsBrief, loadAccess, loadPeople, patchLogin, removeDirectGrant } from './peopleApi';

const fakeApi = (over: Partial<Record<keyof HostApi, any>> = {}): HostApi & Record<keyof HostApi, ReturnType<typeof vi.fn>> =>
	({
		get: vi.fn(async () => ({ data: {} })),
		post: vi.fn(async () => ({ data: {} })),
		patch: vi.fn(async () => ({ data: {} })),
		delete: vi.fn(async () => ({ data: {} })),
		...over,
	}) as any;

const login = (status: string, id = status) => ({
	user_id: `u-${id}`, email: `${id}@lab.example`, first_name: null, last_name: null, status, role_id: 'r1', role_name: 'Lab Member', last_access: null,
});
const refused = (message: string) => Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { errors: [{ message, extensions: { code: 'X' } }] } } });

describe('a Former person is never missing an email', () => {
	it('personAttention drops missing_email for active = false and keeps the other checks', () => {
		expect(personAttention({ active: false, attention: ['missing_email', 'former_login_active'] })).toEqual(['former_login_active']);
		expect(personAttention({ active: true, attention: ['missing_email'] })).toEqual(['missing_email']);
		expect(personAttention({ active: false })).toEqual([]);
	});
	it('loadPeople applies it to the rows', async () => {
		const api = fakeApi({
			get: vi.fn(async () => ({ data: { people: [{ person_id: 'p1', full_name: 'Gone', email: null, active: false, user_id: null, login: null, attention: ['missing_email'] }], logins_without_person: [] } })),
		});
		expect((await loadPeople(api, true)).rows[0].attention).toEqual([]);
	});
});

describe('loadPeople', () => {
	it('an administrator gets persons plus active, invited and suspended logins as login rows', async () => {
		const api = fakeApi({
			get: vi.fn(async () => ({
				data: {
					can_administer_accounts: true,
					roles: [{ id: 'r1', name: 'Lab Member' }],
					people: [{ person_id: 'p1', full_name: 'Ann', email: null, is_researcher: true, is_operator: false, active: true, notes: null, user_id: null, login: null, attention: ['missing_email'] }],
					logins_without_person: [login('active'), login('invited'), login('suspended'), login('archived'), login('draft')],
				},
			})),
		});
		const data = await loadPeople(api, true);
		expect(api.get).toHaveBeenCalledWith('/d1-people-admin/people');
		expect(data.canAdministerAccounts).toBe(true);
		expect(data.roles).toEqual([{ id: 'r1', name: 'Lab Member' }]);
		expect(data.rows.map((r) => [r.kind, r.person_id, r.user_id])).toEqual([
			['person', 'p1', null], ['login', null, 'u-active'], ['login', null, 'u-invited'], ['login', null, 'u-suspended'],
		]);
		expect(data.rows[1]).toMatchObject({ full_name: 'active@lab.example', attention: ['login_without_person'], login: { status: 'active', role_id: 'r1' } });
		expect(data.rows[2].attention).toEqual(['login_without_person', 'invite_not_accepted']);
		expect(data.rows[3].attention).toEqual(['login_without_person']);
	});

	it('a member reads /items/people and gets person rows with no login and no attention', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { data: [{ person_id: 'p1', full_name: 'Ann', email: 'a@x.y', is_researcher: true, is_operator: false, active: false }] } })) });
		const data = await loadPeople(api, false);
		expect(api.get).toHaveBeenCalledWith('/items/people', { params: { limit: -1, sort: 'full_name' } });
		expect(data.canAdministerAccounts).toBe(false);
		expect(data.rows).toEqual([
			expect.objectContaining({ kind: 'person', person_id: 'p1', full_name: 'Ann', active: false, login: null, attention: [] }),
		]);
	});

	it('a member row carries created_at from /items/people', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { data: [{ person_id: 'p1', full_name: 'Ann', created_at: '2026-03-01T09:30:00Z' }, { person_id: 'p2', full_name: 'Bo' }] } })) });
		const rows = (await loadPeople(api, false)).rows;
		expect(rows.map((r) => r.created_at)).toEqual(['2026-03-01T09:30:00Z', null]);
	});

	it('throws the endpoint message', async () => {
		const api = fakeApi({ get: vi.fn(async () => { throw refused('Only an administrator can open this.'); }) });
		await expect(loadPeople(api, true)).rejects.toThrow('Only an administrator can open this.');
	});
});

describe('teams', () => {
	const TEAMS = { teams: [{ team_id: 't2', name: 'beta', color: 'blue', logo: 'f1', member_count: 3 }, { team_id: 't1', name: 'Alpha', color: 'teal', logo: null }] };
	const byUrl = (answers: Record<string, any>) => vi.fn(async (url: string) => ({ data: answers[url] ?? {} }));

	it('listTeamsBrief reads GET /d1-teams and keeps id, name, colour and logo, by name', async () => {
		const api = fakeApi({ get: byUrl({ '/d1-teams': TEAMS }) });
		expect(await listTeamsBrief(api)).toEqual([
			{ team_id: 't1', name: 'Alpha', color: 'teal', logo: null },
			{ team_id: 't2', name: 'beta', color: 'blue', logo: 'f1' },
		]);
		expect(api.get).toHaveBeenCalledWith('/d1-teams');
	});

	it('an administrator gets the teams of each person from the endpoint, and the team list', async () => {
		const mine = [{ team_id: 't1', name: 'Alpha', color: 'teal', logo: null, is_manager: true }];
		const api = fakeApi({
			get: byUrl({
				'/d1-people-admin/people': { can_administer_accounts: true, roles: [], people: [{ person_id: 'p1', full_name: 'Ann', teams: mine }, { person_id: 'p2', full_name: 'Bo' }], logins_without_person: [] },
				'/d1-teams': TEAMS,
			}),
		});
		const data = await loadPeople(api, true);
		expect(data.rows.map((r) => r.teams)).toEqual([mine, []]);
		expect(data.teams.map((t) => t.team_id)).toEqual(['t1', 't2']);
	});

	it('a member gets memberships from /items/team_members joined with the teams', async () => {
		const api = fakeApi({
			get: byUrl({
				'/items/people': { data: [{ person_id: 'p1', full_name: 'Ann' }, { person_id: 'p2', full_name: 'Bo' }, { person_id: 'p3', full_name: 'Cy' }] },
				'/items/team_members': { data: [
					{ team_id: 't2', person_id: 'p1', is_manager: true },
					{ team_id: 't1', person_id: 'p1', is_manager: false },
					{ team_id: 't1', person_id: 'p2', is_manager: false },
					{ team_id: 'gone', person_id: 'p3', is_manager: false },
				] },
				'/d1-teams': TEAMS,
			}),
		});
		const data = await loadPeople(api, false);
		expect(api.get).toHaveBeenCalledWith('/items/team_members', { params: { fields: 'team_id,person_id,is_manager', limit: -1 } });
		expect(data.rows.map((r) => (r.teams ?? []).map((t) => [t.team_id, t.name, t.is_manager]))).toEqual([
			[['t2', 'beta', true], ['t1', 'Alpha', false]],
			[['t1', 'Alpha', false]],
			[],
		]);
		expect(data.teams.map((t) => t.team_id)).toEqual(['t1', 't2']);
	});

	it('the people still load when the teams cannot be read', async () => {
		const api = fakeApi({
			get: vi.fn(async (url: string) => {
				if (url === '/items/people') return { data: { data: [{ person_id: 'p1', full_name: 'Ann' }] } };
				throw refused('No teams for you.');
			}),
		});
		const data = await loadPeople(api, false);
		expect(data.teams).toEqual([]);
		expect(data.rows[0]!.teams).toEqual([]);
	});

	it('loadAccess carries the teams and waiting counts (0 when the server leaves them out)', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { owns: 1, shared: 0, investigator: 0, teams: 4, waiting: 3, waiting_owners: 2 } })) });
		expect(await loadAccess(api, 'p1', 'teams')).toMatchObject({ teams: 4, waiting: 3, waiting_owners: 2 });
		expect(api.get).toHaveBeenCalledWith('/d1-people-admin/people/p1/access', { params: { list: 'teams' } });
		const old = fakeApi({ get: vi.fn(async () => ({ data: { owns: 1, shared: 0, investigator: 0 } })) });
		expect(await loadAccess(old, 'p1')).toMatchObject({ teams: 0, waiting: 0, waiting_owners: 0 });
	});
});

describe('the other calls', () => {
	it('loadAccess asks for one list when given one', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { owns: 2, shared: 1, investigator: 0, records: [] } })) });
		expect(await loadAccess(api, 'p 1', 'owns')).toMatchObject({ owns: 2 });
		expect(api.get).toHaveBeenCalledWith('/d1-people-admin/people/p%201/access', { params: { list: 'owns' } });
		await loadAccess(api, 'p1');
		expect(api.get).toHaveBeenLastCalledWith('/d1-people-admin/people/p1/access', undefined);
	});

	it('patchLogin sends the body and throws the endpoint message on a refusal', async () => {
		const api = fakeApi({ patch: vi.fn(async () => ({ data: { user_id: 'u1', role_id: 'r1', role_name: 'X', status: 'suspended' } })) });
		expect((await patchLogin(api, 'u1', { status: 'suspended' })).status).toBe('suspended');
		expect(api.patch).toHaveBeenCalledWith('/d1-people-admin/logins/u1', { status: 'suspended' });
		const refusing = fakeApi({ patch: vi.fn(async () => { throw refused('That would leave no active account administrator.'); }) });
		await expect(patchLogin(refusing, 'u1', { status: 'suspended' })).rejects.toThrow('That would leave no active account administrator.');
	});

	it('invite resolves for both the 201 and the 200 answer', async () => {
		for (const status of [201, 200]) {
			const api = fakeApi({ post: vi.fn(async () => ({ status, data: { user_id: 'u1', person_id: 'p1', status: 'invited', email_sent: true } })) });
			expect(await invite(api, { email: 'a@x.y', full_name: 'Ann' })).toMatchObject({ user_id: 'u1', email_sent: true });
		}
	});

	it('a refusal keeps its status, code and extensions (EMAIL_HAS_LOGIN names the person)', async () => {
		const err = Object.assign(new Error('Request failed with status code 409'), {
			response: { status: 409, data: { errors: [{ message: 'That e-mail already has a login.', extensions: { code: 'EMAIL_HAS_LOGIN', source: 'd1-people-admin', person_id: 'p9' } }] } },
		});
		const api = fakeApi({ post: vi.fn(async () => { throw err; }) });
		const caught = await invite(api, { email: 'a@x.y', full_name: 'Ann' }).catch((e) => e);
		expect(caught).toBeInstanceOf(PeopleApiError);
		expect(caught).toMatchObject({ message: 'That e-mail already has a login.', status: 409, code: 'EMAIL_HAS_LOGIN' });
		expect(caught.extensions.person_id).toBe('p9');
		// a network error has no response: message only
		const down = await invite(fakeApi({ post: vi.fn(async () => { throw new Error('Network Error'); }) }), { email: 'a@x.y' }).catch((e) => e);
		expect(down).toBeInstanceOf(PeopleApiError);
		expect(down).toMatchObject({ message: 'Network Error', status: undefined, code: undefined });
	});

	it('removeDirectGrant calls the record-access entries route', async () => {
		const api = fakeApi({ delete: vi.fn(async () => ({ data: { removed: true } })) });
		expect(await removeDirectGrant(api, 'samples', 'S 1', 'p1')).toEqual({ removed: true });
		expect(api.delete).toHaveBeenCalledWith('/d1-record-access/samples/S%201/entries/p1');
	});
});
