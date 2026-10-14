import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { invite, loadAccess, loadPeople, patchLogin, removeDirectGrant } from './peopleApi';

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

	it('throws the endpoint message', async () => {
		const api = fakeApi({ get: vi.fn(async () => { throw refused('Only an administrator can open this.'); }) });
		await expect(loadPeople(api, true)).rejects.toThrow('Only an administrator can open this.');
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

	it('removeDirectGrant calls the record-access entries route', async () => {
		const api = fakeApi({ delete: vi.fn(async () => ({ data: { removed: true } })) });
		expect(await removeDirectGrant(api, 'samples', 'S 1', 'p1')).toEqual({ removed: true });
		expect(api.delete).toHaveBeenCalledWith('/d1-record-access/samples/S%201/entries/p1');
	});
});
