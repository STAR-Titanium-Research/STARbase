import { describe, expect, it, vi } from 'vitest';
import type { AccessApi } from './accessApi';
import { useAccess } from './useAccess';

const fail = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });
const listBody = (over: Record<string, unknown> = {}) => ({ restricted: false, owner: null, project_pi: null, can_manage: true, entries: [], ...over });

function fakeApi(handlers: { get?: (path: string) => any; post?: any; patch?: any; delete?: any } = {}) {
	return {
		get: vi.fn(async (path: string) => ({ data: handlers.get ? handlers.get(path) : listBody() })),
		post: vi.fn(async (...a: any[]) => ({ data: handlers.post ? handlers.post(...a) : {} })),
		patch: vi.fn(async (...a: any[]) => ({ data: handlers.patch ? handlers.patch(...a) : {} })),
		delete: vi.fn(async (...a: any[]) => ({ data: handlers.delete ? handlers.delete(...a) : {} })),
	} as unknown as AccessApi & Record<'get' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;
}

describe('useAccess', () => {
	it('loads the list and says why when it cannot', async () => {
		const api = fakeApi();
		const a = useAccess(api, () => ({ collection: 'physical_samples', id: 's1' }));
		expect(await a.load()).toBe(true);
		expect(a.list.value?.can_manage).toBe(true);
		const bad = fakeApi({ get: () => { throw fail(404, 'That record does not exist, or you cannot see it.'); } });
		const b = useAccess(bad, () => ({ collection: 'physical_samples', id: 's1' }));
		expect(await b.load()).toBe(false);
		expect(b.error.value).toBe('That record does not exist, or you cannot see it.');
		expect(b.list.value).toBeNull();
	});

	it('refuses a collection with no access list without asking the server', async () => {
		const api = fakeApi();
		const a = useAccess(api, () => ({ collection: 'people', id: 'x' }));
		expect(await a.load()).toBe(false);
		expect(api.get).not.toHaveBeenCalled();
	});

	it('refetches after a write and tells the page', async () => {
		const api = fakeApi({ post: () => ({ entry: null, email: 'sent' }) });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		api.get.mockClear();
		expect(await a.add('p1', 'view')).toBe(true);
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(a.note.value).toBe('Added.');
		expect(a.busy.value).toBe(false);
	});

	it('says "Added. The email could not be sent." when the mail failed, and the change still counts', async () => {
		const api = fakeApi({ post: () => ({ email: 'failed' }) });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		await a.add('p1', 'edit');
		expect(a.note.value).toBe('Added. The email could not be sent.');
		expect(a.error.value).toBe('');
		expect(changed).toHaveBeenCalled();
	});

	it('shows a failed write and still refreshes (a 404 on remove means the person is gone already)', async () => {
		const api = fakeApi({ delete: () => { throw fail(404, 'That person is not on the list.'); } });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'projects', id: 'p1' }), changed);
		await a.load();
		api.get.mockClear();
		expect(await a.remove('q')).toBe(false);
		expect(a.error.value).toBe('That person is not on the list.');
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(changed).not.toHaveBeenCalled();
	});

	it('words a transfer and its failed email', async () => {
		const ok = fakeApi({ post: () => ({ email: 'sent' }) });
		const a = useAccess(ok, () => ({ collection: 'physical_samples', id: 's1' }));
		await a.load();
		await a.transferTo('q');
		expect(a.note.value).toBe('Ownership transferred.');
		const mail = fakeApi({ post: () => ({ email: 'failed' }) });
		const b = useAccess(mail, () => ({ collection: 'physical_samples', id: 's1' }));
		await b.load();
		await b.transferTo('q');
		expect(b.note.value).toContain('could not be sent');
	});

	it('reads the sample behind an operation and shows it only when neither is restricted', async () => {
		const sample = listBody({ owner: { person_id: 'o', name: 'Ada', can_sign_in: true }, entries: [{ person_id: 'p', name: 'Edith', role: 'view' }] });
		const api = fakeApi({ get: (path) => (path.includes('physical_samples') ? sample : listBody()) });
		const a = useAccess(api, () => ({ collection: 'manufacturing_operations', id: 'o1', parent: { collection: 'physical_samples', id: 's1' } }));
		await a.load();
		expect(a.parentList.value?.owner?.name).toBe('Ada');

		const restricted = fakeApi({ get: (path) => (path.includes('physical_samples') ? { ...sample, restricted: true } : listBody()) });
		const b = useAccess(restricted, () => ({ collection: 'manufacturing_operations', id: 'o1', parent: { collection: 'physical_samples', id: 's1' } }));
		await b.load();
		expect(b.parentList.value).toBeNull();

		const ownRestricted = fakeApi({ get: (path) => (path.includes('physical_samples') ? sample : listBody({ restricted: true })) });
		const c = useAccess(ownRestricted, () => ({ collection: 'test_sessions', id: 't1', parent: { collection: 'physical_samples', id: 's1' } }));
		await c.load();
		expect(c.parentList.value).toBeNull();
		expect(ownRestricted.get).toHaveBeenCalledTimes(1); // no need to read the parent of a restricted record

		const hidden = fakeApi({ get: (path) => { if (path.includes('physical_samples')) throw fail(404, 'no'); return listBody(); } });
		const d = useAccess(hidden, () => ({ collection: 'test_sessions', id: 't1', parent: { collection: 'physical_samples', id: 's1' } }));
		expect(await d.load()).toBe(true);
		expect(d.parentList.value).toBeNull();
		expect(d.error.value).toBe('');
	});
});
