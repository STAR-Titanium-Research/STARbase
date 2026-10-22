import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { loadProgress, parseProgressFolder } from './inboxApi';
import { createFakeInbox, progressFolder } from './fakeInboxServer';
import { createScanProgress } from './useScanProgress';

const refused = (status: number, message = 'no') => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message, extensions: { code: 'FORBIDDEN' } }] } } });

describe('loadProgress', () => {
	it('reads the caller\'s own folders, and asks for all=1 only when told to', async () => {
		const fake = createFakeInbox({ progress: { folders: [progressFolder()], last_scan_finished_at: '2026-10-15T11:45:00.000Z' }, progressAll: { folders: [progressFolder(), progressFolder({ owner: { id: 'p2', name: 'Bo Chan' } })], last_scan_finished_at: null } });
		const own = await loadProgress(fake.api);
		expect(own.folders.map((f) => f.owner.name)).toEqual(['Ann Lee']);
		expect(own.last_scan_finished_at).toBe('2026-10-15T11:45:00.000Z');
		const all = await loadProgress(fake.api, { all: true });
		expect(all.folders).toHaveLength(2);
		expect(all.last_scan_finished_at).toBeNull();
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/progress').map((c) => c.params ?? null)).toEqual([null, { all: 1 }]);
	});

	it('a non-administrator\'s all=1 is the endpoint\'s own refusal', async () => {
		const fake = createFakeInbox({ progressAllowed: false });
		await expect(loadProgress(fake.api, { all: true })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Only administrators can do that.' });
	});

	it('reads what the server sends carefully: odd counts are 0, a folder with no owner id is dropped, an answer with no folders is none', async () => {
		const fake = createFakeInbox();
		const api: HostApi = { ...fake.api, get: async () => ({ data: { data: { folders: [{ owner: { id: 'x', name: 'X', kind: 'team' }, files: '12', images: -4, folders_known: 'many' }, { owner: {} }, null, 'x'] } } }) as any };
		const r = await loadProgress(api);
		expect(r.folders).toHaveLength(1);
		expect(r.folders[0]).toMatchObject({ owner: { id: 'x', kind: 'team', name: 'X', folder: '', root: '', has_login: null }, files: 12, images: 0, folders_known: 0, sem_with_scale: 0 });
		expect(r.last_scan_finished_at).toBeNull();
		expect(parseProgressFolder(undefined)).toBeNull();
	});
});

describe('createScanProgress', () => {
	it('loads the folders and when the scan finished', async () => {
		const s = createScanProgress(createFakeInbox({ progress: { folders: [progressFolder()], last_scan_finished_at: '2026-10-15T11:45:00.000Z' } }).api);
		expect(s.loaded.value).toBe(false);
		await s.load();
		expect(s.loaded.value).toBe(true);
		expect(s.loading.value).toBe(false);
		expect(s.folders.value).toHaveLength(1);
		expect(s.lastScanFinishedAt.value).toBe('2026-10-15T11:45:00.000Z');
		expect(s.error.value).toBe('');
	});

	it('a server with no such route (404) or a refusal (403) is no progress to show, not an error', async () => {
		for (const status of [404, 403]) {
			const s = createScanProgress({ get: vi.fn(async () => { throw refused(status); }) } as unknown as HostApi);
			await s.load();
			expect(s.loaded.value).toBe(true);
			expect(s.folders.value).toEqual([]);
			expect(s.error.value).toBe('');
		}
	});

	it('any other failure is an error line, and a later refresh that fails keeps what was shown', async () => {
		const fake = createFakeInbox({ progress: { folders: [progressFolder()], last_scan_finished_at: null } });
		let fail = false;
		const api: HostApi = { ...fake.api, get: async (p, c) => { if (fail) throw refused(500, 'The database is busy.'); return fake.api.get(p, c); } };
		const s = createScanProgress(api);
		await s.load();
		fail = true;
		await s.load();
		expect(s.error.value).toBe('Could not read the scan progress: The database is busy.');
		expect(s.folders.value).toHaveLength(1);
		fail = false;
		await s.load();
		expect(s.error.value).toBe('');
	});

	it('asks again only when the last request is over (a poll never piles up)', async () => {
		const fake = createFakeInbox({ progress: { folders: [], last_scan_finished_at: null } });
		const s = createScanProgress(fake.api);
		await Promise.all([s.load(), s.load(), s.load()]);
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/progress')).toHaveLength(1);
	});
});
