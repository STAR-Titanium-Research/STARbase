import { describe, expect, it, vi } from 'vitest';
import { addEntry, loadAccess, removeEntry, searchPeople, setRole, transfer, type AccessApi } from './accessApi';

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

describe('loadAccess', () => {
	it('reads the bare JSON of the endpoint and fills what is missing', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { restricted: false, owner: { person_id: 'o', name: 'Ada', can_sign_in: true }, can_manage: true, entries: [{ person_id: 'p', name: 'E', role: 'view' }] } })) });
		const res = await loadAccess(api, 'physical_samples', 'abc/1');
		expect(api.get).toHaveBeenCalledWith('/d1-record-access/physical_samples/abc%2F1');
		expect(res).toEqual({ ok: true, data: { restricted: false, owner: { person_id: 'o', name: 'Ada', can_sign_in: true }, project_pi: null, can_manage: true, entries: [{ person_id: 'p', name: 'E', role: 'view' }] } });
	});
	it('does not let a missing can_manage become true', async () => {
		const res = await loadAccess(fakeApi({ get: vi.fn(async () => ({ data: { entries: 'nope' } })) }), 'projects', 'p');
		expect(res).toMatchObject({ ok: true, data: { can_manage: false, entries: [] } });
	});
	it('surfaces the endpoint message', async () => {
		const res = await loadAccess(fakeApi({ get: vi.fn(async () => { throw fail(404, 'That record does not exist, or you cannot see it.'); }) }), 'projects', 'p');
		expect(res).toEqual({ ok: false, message: 'That record does not exist, or you cannot see it.' });
	});
});

describe('writes', () => {
	it('adds an entry and reports the email', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { entry: { person_id: 'p', name: 'E', role: 'edit' }, email: 'failed' } })) });
		const res = await addEntry(api, 'campaigns', 'c1', 'p', 'edit');
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/entries', { person_id: 'p', role: 'edit' });
		expect(res).toMatchObject({ ok: true, data: { email: 'failed' } });
	});
	it('treats a missing email field as skipped', async () => {
		expect(await addEntry(fakeApi(), 'campaigns', 'c1', 'p', 'view')).toMatchObject({ ok: true, data: { email: 'skipped' } });
	});
	it('changes a role', async () => {
		const api = fakeApi();
		await setRole(api, 'projects', 'p1', 'q', 'investigator');
		expect(api.patch).toHaveBeenCalledWith('/d1-record-access/projects/p1/entries/q', { role: 'investigator' });
	});
	it('removes an entry and shows the 404 of a person who is no longer listed', async () => {
		const api = fakeApi();
		expect(await removeEntry(api, 'test_sessions', 't1', 'q')).toEqual({ ok: true, data: true });
		expect(api.delete).toHaveBeenCalledWith('/d1-record-access/test_sessions/t1/entries/q');
		const gone = fakeApi({ delete: vi.fn(async () => { throw fail(404, 'That person is not on the list.'); }) });
		expect(await removeEntry(gone, 'test_sessions', 't1', 'q')).toEqual({ ok: false, message: 'That person is not on the list.' });
	});
	it('transfers ownership', async () => {
		const api = fakeApi({ post: vi.fn(async () => ({ data: { owner: {}, email: 'sent' } })) });
		expect(await transfer(api, 'physical_samples', 's1', 'q')).toEqual({ ok: true, data: { email: 'sent' } });
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/physical_samples/s1/transfer', { person_id: 'q' });
	});
	it('falls back to the error text when the server cannot be reached', async () => {
		const res = await setRole(fakeApi({ patch: vi.fn(async () => { throw new Error('Network Error'); }) }), 'projects', 'p', 'q', 'view');
		expect(res).toEqual({ ok: false, message: 'Network Error' });
	});
});

describe('searchPeople', () => {
	it('sends the filter as JSON and returns the rows', async () => {
		const api = fakeApi({ get: vi.fn(async () => ({ data: { data: [{ person_id: 'p', full_name: 'Edith Ford', user_id: null }] } })) });
		const res = await searchPeople(api, 'edi', 6);
		const [path, cfg] = api.get.mock.calls[0] as unknown as [string, { params: Record<string, any> }];
		expect(path).toBe('/items/people');
		expect(JSON.parse(cfg.params.filter)._and[1]).toEqual({ full_name: { _icontains: 'edi' } });
		expect(cfg.params.limit).toBe(6);
		expect(res).toEqual({ ok: true, data: [{ person_id: 'p', full_name: 'Edith Ford', user_id: null }] });
	});
	it('does not ask for an empty search', async () => {
		const api = fakeApi();
		expect(await searchPeople(api, '  ')).toEqual({ ok: true, data: [] });
		expect(api.get).not.toHaveBeenCalled();
	});
});
