import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createTeamFolder } from './teamFolder';

const api = (over: Partial<Record<keyof HostApi, any>> = {}) =>
	({ get: vi.fn(async () => ({ data: { data: { share_folder: 'Additive' } } })), post: vi.fn(), patch: vi.fn(async () => ({ data: {} })), delete: vi.fn(), ...over }) as unknown as HostApi & { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
const failure = (message: string, code?: string, field?: string) => Object.assign(new Error('Request failed'), { response: { status: 400, data: { errors: [{ message, extensions: { ...(code ? { code } : {}), ...(field ? { field } : {}) } }] } } });

describe('createTeamFolder', () => {
	it('reads an existing team\'s share folder as the administrator; nothing is sent when it is unchanged', async () => {
		const a = api();
		const f = createTeamFolder(a);
		f.reset(true);
		expect(f.ready.value).toBe(false);
		await f.load('t1');
		expect(a.get).toHaveBeenCalledWith('/items/teams/t1', { params: { fields: ['share_folder'] } });
		expect([f.folder.value, f.ready.value, f.changed()]).toEqual(['Additive', true, false]);
		expect(await f.apply('t1', 'Additive')).toBeNull();
		expect(a.patch).not.toHaveBeenCalled();
	});

	it('saves a change, trimmed, and an emptied field as null', async () => {
		const a = api();
		const f = createTeamFolder(a);
		f.reset(true);
		await f.load('t1');
		f.folder.value = '  Old project ';
		expect(await f.apply('t1', 'Additive')).toBeNull();
		expect(a.patch).toHaveBeenLastCalledWith('/items/teams/t1', { share_folder: 'Old project' });
		f.folder.value = '';
		expect(await f.apply('t1', 'Additive')).toBeNull();
		expect(a.patch).toHaveBeenLastCalledWith('/items/teams/t1', { share_folder: null });
	});

	it('a new team: set only when something was typed', async () => {
		const a = api();
		const f = createTeamFolder(a);
		f.reset(false);
		expect(await f.apply('t-new', 'Additive')).toBeNull();
		expect(a.patch).not.toHaveBeenCalled();
		f.folder.value = 'Additive';
		expect(await f.apply('t-new', 'Additive')).toBeNull();
		expect(a.patch).toHaveBeenCalledWith('/items/teams/t-new', { share_folder: 'Additive' });
	});

	it('checks it like the database: no slashes or backslashes, not blank, not only dots', () => {
		const f = createTeamFolder(api());
		for (const bad of ['x/y', 'x\\y', '   ', '..']) {
			f.folder.value = bad;
			expect(f.issue.value, bad).not.toBeNull();
		}
		for (const ok of ['Additive', 'Old project', '']) {
			f.folder.value = ok;
			expect(f.issue.value, ok).toBeNull();
		}
	});

	it('a refused save says the team was saved, and a duplicate names no one', async () => {
		const a = api({ patch: vi.fn(async () => { throw failure('Value for field "share_folder" in collection "teams" has to be unique.', 'RECORD_NOT_UNIQUE', 'share_folder'); }) });
		const f = createTeamFolder(a);
		f.reset(false);
		f.folder.value = 'Additive';
		expect(await f.apply('t-new', 'Powder')).toBe('Powder was saved, but the share folder was not: That share folder is already used by another team. Folder names are compared without regard to case.');
	});

	it('sends nothing when the value could not be read', async () => {
		const a = api({ get: vi.fn(async () => { throw new Error('x'); }) });
		const f = createTeamFolder(a);
		f.reset(true);
		await f.load('t1');
		expect(f.loadError.value).toContain('cannot be changed here');
		f.folder.value = 'Something';
		expect(f.changed()).toBe(false);
		expect(await f.apply('t1', 'T')).toBeNull();
		expect(a.patch).not.toHaveBeenCalled();
	});
});
