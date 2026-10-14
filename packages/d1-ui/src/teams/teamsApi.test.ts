import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TeamsApiError, addMember, cachedTeam, clearTeamCache, createTeam, decidePending, deleteTeam, getTeam, listPending, listTeams, onTeamChange, removeMember, setManager,
	updateTeam, uploadTeamLogo, getTeamRecordIds,
} from './teamsApi';

const fail = (status: number, message: string, code?: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message, extensions: { code, source: 'd1-teams', ...extra } }] } } });

function fakeApi(over: Record<string, any> = {}) {
	return {
		get: vi.fn(async (..._a: any[]) => ({ data: {} as any })),
		post: vi.fn(async (..._a: any[]) => ({ data: {} as any })),
		patch: vi.fn(async (..._a: any[]) => ({ data: {} as any })),
		delete: vi.fn(async (..._a: any[]) => ({ data: {} as any })),
		...over,
	} as any;
}

beforeEach(() => clearTeamCache());

describe('reads', () => {
	it('reads the ids of the readable records of a team in one collection', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { ids: ['a', 7], truncated: true } })) });
		expect(await getTeamRecordIds(api, 't/1', 'physical_samples')).toEqual({ ids: ['a', '7'], truncated: true });
		expect(api.get).toHaveBeenCalledWith('/d1-teams/t%2F1/records', { params: { collection: 'physical_samples', limit: 300 } });
		expect(await getTeamRecordIds(fakeApi(), 't1', 'campaigns', 20)).toEqual({ ids: [], truncated: false });
	});
	it('a failed ids read carries the error of the endpoint', async () => {
		const api = fakeApi({ get: vi.fn(async () => { throw fail(404, 'That team does not exist.', 'NOT_FOUND'); }) });
		await expect(getTeamRecordIds(api, 't1', 'campaigns')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
	});
	it('lists the teams', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { teams: [{ team_id: 't1', name: 'A' }] } })) });
		expect(await listTeams(api)).toEqual([{ team_id: 't1', name: 'A' }]);
		expect(api.get).toHaveBeenCalledWith('/d1-teams');
	});
	it('answers an empty list when the body has no teams', async () => {
		expect(await listTeams(fakeApi())).toEqual([]);
	});
	it('reads one team and fills what is missing', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { team: { team_id: 't/1', name: 'A' }, members: [{ person_id: 'p' }] } })) });
		const t = await getTeam(api, 't/1');
		expect(api.get).toHaveBeenCalledWith('/d1-teams/t%2F1', undefined);
		expect(t.team.name).toBe('A');
		expect(t.members).toHaveLength(1);
		expect(t.records).toEqual([]);
		expect(t.events).toEqual([]);
		expect(t.hidden_count).toBe(0);
		expect(t.counts).toEqual({ view: 0, edit: 0, investigator: 0, owns: 0 });
	});
	it('keeps the count of records the team owns', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { team: {}, counts: { view: 1, edit: 2, investigator: 0, owns: 5 } } })) });
		expect((await getTeam(api, 't1')).counts).toEqual({ view: 1, edit: 2, investigator: 0, owns: 5 });
	});
	it('can ask for every event', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { team: {} } })) });
		await getTeam(api, 't1', { events: 'all' });
		expect(api.get).toHaveBeenCalledWith('/d1-teams/t1', { params: { events: 'all' } });
	});
	it('lists the pending approvals', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { items: [{ team_id: 't', team_name: 'A', person_id: 'p', full_name: 'E', records: [] }] } })) });
		expect(await listPending(api)).toHaveLength(1);
		expect(api.get).toHaveBeenCalledWith('/d1-teams/pending');
	});
});

describe('writes', () => {
	it('creates a team (name, description, colour)', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { team_id: 't1', name: 'A', color: 'blue' } })) });
		const t = await createTeam(api, { name: 'A', color: 'blue' });
		expect(api.post).toHaveBeenCalledWith('/d1-teams', { name: 'A', color: 'blue' });
		expect(t.team_id).toBe('t1');
	});
	it('edits and deletes a team', async () => {
		const api = fakeApi({ patch: vi.fn(async () => ({ data: { team_id: 't1', name: 'B' } })), delete: vi.fn(async () => ({ data: { deleted: true, owners_mailed: 2 } })) });
		expect((await updateTeam(api, 't1', { name: 'B', logo: null })).name).toBe('B');
		expect(api.patch).toHaveBeenCalledWith('/d1-teams/t1', { name: 'B', logo: null });
		expect(await deleteTeam(api, 't1')).toEqual({ deleted: true, owners_mailed: 2 });
		expect(api.delete).toHaveBeenCalledWith('/d1-teams/t1');
	});
	it('adds, promotes and removes a member', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { pending: 2, owners_asked: 1, owned_edit: 0 } })) });
		expect(await addMember(api, 't1', 'p1', true)).toEqual({ pending: 2, owners_asked: 1, owned_edit: 0 });
		expect(api.post).toHaveBeenCalledWith('/d1-teams/t1/members', { person_id: 'p1', is_manager: true });
		await addMember(api, 't1', 'p2');
		expect(api.post).toHaveBeenLastCalledWith('/d1-teams/t1/members', { person_id: 'p2', is_manager: false });
		await setManager(api, 't1', 'p1', false);
		expect(api.patch).toHaveBeenCalledWith('/d1-teams/t1/members/p1', { is_manager: false });
		await removeMember(api, 't1', 'p1');
		expect(api.delete).toHaveBeenCalledWith('/d1-teams/t1/members/p1');
	});
	it('decides pending joiners, for every record or only some', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { decision: 'approve', decided: 3, records: [] } })) });
		await decidePending(api, { team_id: 't', person_id: 'p', decision: 'approve' });
		expect(api.post).toHaveBeenCalledWith('/d1-teams/pending/decide', { team_id: 't', person_id: 'p', decision: 'approve' });
		await decidePending(api, { team_id: 't', person_id: 'p', decision: 'decline', records: [{ collection: 'projects', id: 'x' }] });
		expect(api.post).toHaveBeenLastCalledWith('/d1-teams/pending/decide', { team_id: 't', person_id: 'p', decision: 'decline', records: [{ collection: 'projects', id: 'x' }] });
	});
});

describe('uploadTeamLogo', () => {
	it('posts the file to /files as form data and returns its id', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { data: { id: 'file-1' } } })) });
		const file = new File(['x'], 'logo.png', { type: 'image/png' });
		expect(await uploadTeamLogo(api, file)).toBe('file-1');
		const [path, body] = api.post.mock.calls[0];
		expect(path).toBe('/files');
		expect(body).toBeInstanceOf(FormData);
		expect((body as FormData).get('file')).toBeInstanceOf(File);
	});
	it('fails when the server returns no id', async () => {
		await expect(uploadTeamLogo(fakeApi(), new File(['x'], 'l.png'))).rejects.toBeInstanceOf(TeamsApiError);
	});
});

describe('errors', () => {
	it('throws a TeamsApiError carrying status, code and extensions', async () => {
		const api = fakeApi({ post: vi.fn(async () => { throw fail(409, 'Make someone else a manager first', 'LAST_MANAGER', { person_id: 'p' }); }) });
		const err = await addMember(api, 't', 'p').catch((e) => e);
		expect(err).toBeInstanceOf(TeamsApiError);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe('Make someone else a manager first');
		expect(err.status).toBe(409);
		expect(err.code).toBe('LAST_MANAGER');
		expect(err.extensions).toMatchObject({ source: 'd1-teams', person_id: 'p' });
	});
	it('leaves status and code unset for a network error', async () => {
		const api = fakeApi({ get: vi.fn(async () => { throw new Error('Network Error'); }) });
		const err = await listTeams(api).catch((e) => e);
		expect(err).toBeInstanceOf(TeamsApiError);
		expect(err.message).toBe('Network Error');
		expect(err.status).toBeUndefined();
		expect(err.code).toBeUndefined();
	});
	it('every call maps its failure', async () => {
		const boom = vi.fn(async () => { throw fail(403, 'No.', 'FORBIDDEN'); });
		const api = fakeApi({ get: boom, post: boom, patch: boom, delete: boom });
		const calls = [
			() => listTeams(api), () => getTeam(api, 't'), () => createTeam(api, { name: 'x' }), () => updateTeam(api, 't', {}), () => deleteTeam(api, 't'),
			() => addMember(api, 't', 'p'), () => setManager(api, 't', 'p', true), () => removeMember(api, 't', 'p'), () => listPending(api),
			() => decidePending(api, { team_id: 't', person_id: 'p', decision: 'approve' }), () => uploadTeamLogo(api, new File(['x'], 'l.png')),
		];
		for (const call of calls) await expect(call()).rejects.toMatchObject({ name: 'TeamsApiError', status: 403, code: 'FORBIDDEN' });
	});
});

describe('cachedTeam', () => {
	const api = () => fakeApi({ get: vi.fn(async () => ({ data: { team: { team_id: 't1', name: 'A' }, members: [] } })) });
	it('fetches a team once and shares the answer', async () => {
		const a = api();
		const [x, y] = await Promise.all([cachedTeam(a, 't1'), cachedTeam(a, 't1')]);
		await cachedTeam(a, 't1');
		expect(a.get).toHaveBeenCalledTimes(1);
		expect(x).toBe(y);
	});
	it('forgets a failure so the next hover retries', async () => {
		const a = fakeApi({ get: vi.fn().mockRejectedValueOnce(fail(500, 'x')).mockResolvedValue({ data: { team: { team_id: 't1' } } }) });
		await expect(cachedTeam(a, 't1')).rejects.toBeInstanceOf(TeamsApiError);
		await expect(cachedTeam(a, 't1')).resolves.toBeTruthy();
		expect(a.get).toHaveBeenCalledTimes(2);
	});
	it('clearTeamCache(id) drops one team, with no id drops all', async () => {
		const a = api();
		await cachedTeam(a, 't1');
		clearTeamCache('t1');
		await cachedTeam(a, 't1');
		expect(a.get).toHaveBeenCalledTimes(2);
		clearTeamCache();
		await cachedTeam(a, 't1');
		expect(a.get).toHaveBeenCalledTimes(3);
	});
});

describe('a change forgets the kept read of its team', () => {
	it('after update, delete, add, promote and remove (and not after a failure)', async () => {
		const get = vi.fn(async () => ({ data: { team: { team_id: 't1' }, members: [] } }));
		const api = fakeApi({ get });
		const writes: [string, () => Promise<unknown>][] = [
			['update', () => updateTeam(api, 't1', { name: 'B' })],
			['delete', () => deleteTeam(api, 't1')],
			['add', () => addMember(api, 't1', 'p')],
			['promote', () => setManager(api, 't1', 'p', true)],
			['remove', () => removeMember(api, 't1', 'p')],
		];
		for (const [, write] of writes) {
			clearTeamCache();
			get.mockClear();
			await cachedTeam(api, 't1');
			await write();
			await cachedTeam(api, 't1');
			expect(get).toHaveBeenCalledTimes(2);
		}
		const bad = fakeApi({ get, patch: vi.fn(async () => { throw fail(403, 'No.', 'FORBIDDEN'); }) });
		clearTeamCache();
		get.mockClear();
		await cachedTeam(bad, 't1');
		await updateTeam(bad, 't1', { name: 'B' }).catch(() => undefined);
		await cachedTeam(bad, 't1');
		expect(get).toHaveBeenCalledTimes(1);
	});
});

describe('onTeamChange', () => {
	it('tells a subscriber when its team is cleared, not other teams, and stops after unsubscribe', () => {
		const a = vi.fn();
		const b = vi.fn();
		const stopA = onTeamChange('t1', a);
		onTeamChange('t2', b);
		clearTeamCache('t1');
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		clearTeamCache();
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(1);
		stopA();
		clearTeamCache('t1');
		expect(a).toHaveBeenCalledTimes(2);
		clearTeamCache('t2');
		expect(b).toHaveBeenCalledTimes(2);
	});
	it('drops the kept read before it tells, so a refetch inside the callback is fresh', async () => {
		const get = vi.fn(async () => ({ data: { team: { team_id: 't1' } } }));
		const api = fakeApi({ get });
		await cachedTeam(api, 't1');
		let refetched = 0;
		onTeamChange('t1', () => { void cachedTeam(api, 't1').then(() => (refetched += 1)); });
		clearTeamCache('t1');
		await Promise.resolve();
		expect(get).toHaveBeenCalledTimes(2);
	});
	it('is told after each successful write, and not after a failed one', async () => {
		const fn = vi.fn();
		onTeamChange('t1', fn);
		const api = fakeApi();
		await updateTeam(api, 't1', { name: 'B' });
		await deleteTeam(api, 't1');
		await addMember(api, 't1', 'p');
		await setManager(api, 't1', 'p', true);
		await removeMember(api, 't1', 'p');
		expect(fn).toHaveBeenCalledTimes(5);
		const bad = fakeApi({ post: vi.fn(async () => { throw fail(409, 'x', 'LAST_MANAGER'); }) });
		await addMember(bad, 't1', 'p').catch(() => undefined);
		expect(fn).toHaveBeenCalledTimes(5);
	});
	it('lets a callback unsubscribe itself while being told', () => {
		const calls: string[] = [];
		const stop = onTeamChange('t9', () => { calls.push('a'); stop(); });
		onTeamChange('t9', () => calls.push('b'));
		clearTeamCache('t9');
		clearTeamCache('t9');
		expect(calls).toEqual(['a', 'b', 'b']);
	});
});
