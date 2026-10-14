import { describe, expect, it, vi } from 'vitest';
import type { AccessApi } from './accessApi';
import { useAccess } from './useAccess';

const fail = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });
const listBody = (over: Record<string, unknown> = {}) => ({ restricted: false, owner: null, project_pi: null, can_manage: true, entries: [], ...over });
const teamRow = { team_access_id: 'a', team_id: 't1', name: 'Sintering', color: 'teal', logo: null, member_count: 3, role: 'view', trust_new_members: false, waiting: 1, declined: 1 };

function fakeApi(handlers: { get?: (path: string) => any; post?: any; patch?: any; delete?: any } = {}) {
	return {
		get: vi.fn(async (path: string) => ({ data: handlers.get ? handlers.get(path) : listBody() })),
		post: vi.fn(async (...a: any[]) => ({ data: handlers.post ? handlers.post(...a) : {} })),
		patch: vi.fn(async (...a: any[]) => ({ data: handlers.patch ? handlers.patch(...a) : {} })),
		delete: vi.fn(async (...a: any[]) => ({ data: handlers.delete ? handlers.delete(...a) : {} })),
	} as unknown as AccessApi & Record<'get' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;
}

describe('useAccess: teams', () => {
	it('keeps the teams of the list', async () => {
		const a = useAccess(fakeApi({ get: () => listBody({ teams: [teamRow] }) }), () => ({ collection: 'campaigns', id: 'c1' }));
		await a.load();
		expect(a.list.value?.teams).toEqual([teamRow]);
	});

	it('adds a team, refetches and tells the page', async () => {
		const api = fakeApi({ post: () => ({ team: {}, email: 'sent', emails: { sent: 3, skipped: 0, failed: 0 } }) });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		api.get.mockClear();
		expect(await a.addTeam('t1', 'edit')).toBe(true);
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/entries', { team_id: 't1', role: 'edit' });
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(a.note.value).toBe('Added.');
	});

	it('says some emails could not be sent, and the grant still counts', async () => {
		const a = useAccess(fakeApi({ post: () => ({ email: 'failed' }) }), () => ({ collection: 'campaigns', id: 'c1' }));
		await a.load();
		expect(await a.addTeam('t1', 'view')).toBe(true);
		expect(a.note.value).toBe('Added. Some emails could not be sent.');
	});

	it('shows the message of a team that is already listed', async () => {
		const api = fakeApi({ post: () => { throw fail(409, 'That team already has access to this record.'); } });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		expect(await a.addTeam('t1', 'view')).toBe(false);
		expect(a.error.value).toBe('That team already has access to this record.');
		expect(changed).not.toHaveBeenCalled();
	});

	it('changes a team level, trusts future members and removes a team', async () => {
		const api = fakeApi();
		const a = useAccess(api, () => ({ collection: 'projects', id: 'p1' }));
		await a.load();
		expect(await a.changeTeam('t1', { role: 'investigator' })).toBe(true);
		expect(api.patch).toHaveBeenLastCalledWith('/d1-record-access/projects/p1/entries/team/t1', { role: 'investigator' });
		expect(await a.changeTeam('t1', { trust_new_members: true })).toBe(true);
		expect(api.patch).toHaveBeenLastCalledWith('/d1-record-access/projects/p1/entries/team/t1', { trust_new_members: true });
		expect(await a.removeTeam('t1')).toBe(true);
		expect(api.delete).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/team/t1');
	});

	it('reads the joiners of a team, and after a decision reads both the list and the joiners again', async () => {
		const members = { active: [], pending: [{ person_id: 'q', name: 'Q', can_sign_in: true, actionable: true }], declined: [] };
		const api = fakeApi({ get: (path) => (path.endsWith('/members') ? members : listBody({ teams: [teamRow] })), post: () => ({ decision: 'approve', email: 'sent' }) });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		expect(await a.loadMembers('t1')).toBe(true);
		expect(a.teamMembers.value.t1).toEqual(members);
		api.get.mockClear();
		expect(await a.decide('t1', 'q', 'approve')).toBe(true);
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/entries/team/t1/members/q', { decision: 'approve' });
		expect(api.get).toHaveBeenCalledTimes(2); // the list and that team's joiners
		expect(changed).toHaveBeenCalledTimes(1);
		expect(a.note.value).toBe('Approved.');
	});

	it('words a decline, and forgets the joiners of a team that was removed', async () => {
		const api = fakeApi({ get: (path) => (path.endsWith('/members') ? { active: [], pending: [], declined: [] } : listBody()), post: () => ({ decision: 'decline' }) });
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }));
		await a.load();
		await a.loadMembers('t1');
		await a.decide('t1', 'q', 'decline');
		expect(a.note.value).toBe('Declined.');
		await a.removeTeam('t1');
		expect(a.teamMembers.value.t1).toBeUndefined();
	});

	it('forgets every list of joiners when another record is loaded', async () => {
		const api = fakeApi({ get: (path) => (path.endsWith('/members') ? { active: [], pending: [], declined: [] } : listBody()) });
		let id = 'c1';
		const a = useAccess(api, () => ({ collection: 'campaigns', id }));
		await a.load();
		await a.loadMembers('t1');
		id = 'c2';
		await a.load();
		expect(a.teamMembers.value).toEqual({});
	});

	it('shows why the joiners could not be read', async () => {
		const api = fakeApi({ get: (path) => { if (path.endsWith('/members')) throw fail(404, 'No such grant.'); return listBody(); } });
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }));
		await a.load();
		expect(await a.loadMembers('t1')).toBe(false);
		expect(a.error.value).toBe('No such grant.');
		expect(a.teamMembers.value.t1).toBeUndefined();
	});
});
