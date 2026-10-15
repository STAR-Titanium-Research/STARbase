import { describe, expect, it, vi } from 'vitest';
import { addTeamEntry, decideTeamMember, loadAccess, loadTeamHits, loadTeamMembers, removeTeamEntry, setTeamEntry, type AccessApi } from './accessApi';

const fail = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });

function fakeApi(over: Partial<Record<keyof AccessApi, any>> = {}) {
	const api = {
		get: vi.fn(async (..._args: any[]) => ({ data: {} as any })),
		post: vi.fn(async (..._args: any[]) => ({ data: {} as any })),
		patch: vi.fn(async (..._args: any[]) => ({ data: {} as any })),
		delete: vi.fn(async (..._args: any[]) => ({ data: {} as any })),
		...over,
	};
	return api as typeof api & AccessApi;
}

describe('teams of the access list', () => {
	it('reads the teams of the list, and an empty array when the server sends none', async () => {
		const teams = [{ team_access_id: 'a', team_id: 't', name: 'Sintering', color: 'teal', logo: null, member_count: 3, role: 'view', trust_new_members: false, waiting: 1, declined: 0 }];
		const res = await loadAccess(fakeApi({ get: vi.fn(async () => ({ data: { teams, entries: [] } })) }), 'projects', 'p');
		expect(res).toMatchObject({ ok: true, data: { teams } });
		expect(await loadAccess(fakeApi({ get: vi.fn(async () => ({ data: { teams: 'nope' } })) }), 'projects', 'p')).toMatchObject({ ok: true, data: { teams: [] } });
	});
});

describe('team entries', () => {
	it('gives a team access', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { team: { team_id: 't' }, email: 'sent', emails: { sent: 2, skipped: 0, failed: 0 } } })) });
		const res = await addTeamEntry(api, 'campaigns', 'c1', 't', 'edit');
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/entries', { team_id: 't', role: 'edit' });
		expect(res).toMatchObject({ ok: true, data: { email: 'sent' } });
		expect(await addTeamEntry(fakeApi(), 'campaigns', 'c1', 't', 'view')).toMatchObject({ ok: true, data: { email: 'skipped' } });
	});
	it('changes a team entry (level, trust) and removes it', async () => {
		const api = fakeApi();
		await setTeamEntry(api, 'projects', 'p1', 't/1', { trust_new_members: true });
		expect(api.patch).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/team/t%2F1', { trust_new_members: true });
		await setTeamEntry(api, 'projects', 'p1', 't1', { role: 'investigator' });
		expect(api.patch).toHaveBeenLastCalledWith('/d1-record-access/projects/p1/entries/team/t1', { role: 'investigator' });
		expect(await removeTeamEntry(api, 'projects', 'p1', 't1')).toEqual({ ok: true, data: true });
		expect(api.delete).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/team/t1');
	});
	it('shows the endpoint message when the team is already listed', async () => {
		const api = fakeApi({ post: vi.fn(async () => { throw fail(409, 'That team already has access to this record.'); }) });
		expect(await addTeamEntry(api, 'projects', 'p1', 't', 'view')).toEqual({ ok: false, message: 'That team already has access to this record.' });
	});
});

describe('who gets access through a team', () => {
	it('reads active, waiting and declined people', async () => {
		const body = { active: [{ person_id: 'a', name: 'A', can_sign_in: true }], pending: [{ person_id: 'b', name: 'B', can_sign_in: true, actionable: true }], declined: [] };
		const api = fakeApi({ get: vi.fn(async () => ({ data: body })) });
		expect(await loadTeamMembers(api, 'projects', 'p1', 't1')).toEqual({ ok: true, data: body });
		expect(api.get).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/team/t1/members');
		expect(await loadTeamMembers(fakeApi(), 'projects', 'p1', 't1')).toEqual({ ok: true, data: { active: [], pending: [], declined: [] } });
	});
	it('approves or declines a waiting person', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { decision: 'approve', email: 'failed' } })) });
		const res = await decideTeamMember(api, 'projects', 'p1', 't1', 'q', 'approve');
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/team/t1/members/q', { decision: 'approve' });
		expect(res).toEqual({ ok: true, data: { decision: 'approve', email: 'failed' } });
	});
});

describe('loadTeamHits', () => {
	it('lists the teams as add-box hits (name, colour, logo, member count)', async () => {
		const api = fakeApi({
			get: vi.fn(async () => ({ data: { teams: [{ team_id: 't', name: 'N', description: 'x', color: 'blue', logo: 'f', member_count: 2, managers: [], is_member: true, is_manager: false }] } })),
		});
		expect(await loadTeamHits(api)).toEqual({ ok: true, data: [{ kind: 'team', team_id: 't', name: 'N', color: 'blue', logo: 'f', member_count: 2 }] });
		expect(api.get).toHaveBeenCalledWith('/d1-teams');
	});
	it('says why the teams could not be read', async () => {
		const api = fakeApi({ get: vi.fn(async () => { throw fail(500, 'Something went wrong on the server.'); }) });
		expect(await loadTeamHits(api)).toEqual({ ok: false, message: 'Something went wrong on the server.' });
	});
});
