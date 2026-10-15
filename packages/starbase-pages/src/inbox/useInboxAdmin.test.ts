import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createInboxAdmin } from './useInboxAdmin';
import { createFakeInbox } from './fakeInboxServer';

const refused = (status: number, message = 'no') => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message }] } } });

describe('createInboxAdmin', () => {
	it('loads the status, the unmatched folders and the people without an alias', async () => {
		const s = createInboxAdmin(createFakeInbox().api);
		await s.load();
		expect(s.loading.value).toBe(false);
		expect(s.data.value?.unmatched_folders).toEqual(['Users/zz9']);
		expect(s.data.value?.people_without_alias).toHaveLength(1);
		expect(s.data.value?.status.interval_minutes).toBe(30);
	});

	it('Scan all queues a scan, says so, and refreshes', async () => {
		const fake = createFakeInbox();
		const s = createInboxAdmin(fake.api);
		await s.load();
		expect(await s.scanAllNow()).toBe(true);
		expect(s.note.value).toBe('Scan of every folder requested. It starts within about 30 seconds.');
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/admin')).toHaveLength(2);
		expect(fake.calls.some((c) => c.method === 'post' && c.path === '/d1-inbox/admin/scan-all')).toBe(true);
	});

	it('a refused Scan all shows the endpoint\'s words', async () => {
		const fake = createFakeInbox();
		const api: HostApi = { ...fake.api, post: vi.fn(async () => { throw refused(403, 'Only administrators may scan everything.'); }) };
		const s = createInboxAdmin(api);
		expect(await s.scanAllNow()).toBe(false);
		expect(s.actionError.value).toBe('Only administrators may scan everything.');
		expect(s.scanning.value).toBe(false);
	});

	it('a server with no d1-inbox (404) is said, not an error, and it stops asking for good', async () => {
		const get = vi.fn(async () => { throw refused(404); });
		const s = createInboxAdmin({ get } as unknown as HostApi);
		await s.load();
		expect(s.missing.value).toBe('no-endpoint');
		expect(s.error.value).toBe('');
		await s.load();
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('a non-administrator (403) is told so, and is asked again next time (a role can change); a 401 is an error line', async () => {
		let status = 403;
		const fake = createFakeInbox();
		const get = vi.fn(async (path: string, config?: any) => {
			if (status === 200) return fake.api.get(path, config);
			throw refused(status);
		});
		const s = createInboxAdmin({ ...fake.api, get } as unknown as HostApi);
		await s.load();
		expect(s.missing.value).toBe('not-admin');
		status = 401;
		await s.load();
		expect(s.error.value).toContain('Could not refresh');
		status = 200;
		await s.load();
		expect(get).toHaveBeenCalledTimes(3);
		expect(s.missing.value).toBe('none');
		expect(s.data.value?.status.daemon).toBe('alive');
	});

	it('a failed refresh keeps the status that was shown and says why', async () => {
		const fake = createFakeInbox();
		const s = createInboxAdmin(fake.api);
		await s.load();
		const spy = vi.spyOn(fake.api, 'get').mockRejectedValue(refused(500, 'Busy.'));
		await s.load();
		expect(s.data.value?.status.interval_minutes).toBe(30);
		expect(s.error.value).toBe('Could not refresh the Inbox crawler status: Busy.');
		spy.mockRestore();
	});
});
