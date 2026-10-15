import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createPersonFolder } from './personFolder';

const api = (over: Partial<Record<keyof HostApi, any>> = {}): HostApi & Record<'get' | 'patch', ReturnType<typeof vi.fn>> =>
	({ get: vi.fn(async () => ({ data: { data: { uni_alias: 'ab1cd', scan_while_former: true } } })), post: vi.fn(), patch: vi.fn(async () => ({ data: {} })), delete: vi.fn(), ...over }) as any;
const failure = (message: string, code?: string) => Object.assign(new Error('Request failed'), { response: { status: 400, data: { errors: [{ message, extensions: code ? { code } : {} }] } } });

describe('createPersonFolder', () => {
	it('reads an existing person\'s alias and Former switch as the administrator, and the fields wait until then', async () => {
		const a = api();
		const f = createPersonFolder(a);
		f.reset(true);
		expect(f.ready.value).toBe(false);
		await f.load('p1');
		expect(a.get).toHaveBeenCalledWith('/items/people/p1', { params: { fields: ['uni_alias', 'scan_while_former'] } });
		expect([f.alias.value, f.scanFormer.value, f.ready.value]).toEqual(['ab1cd', true, true]);
		expect(f.changes()).toEqual({});
	});

	it('sends only what changed: a new alias, an emptied one (null), the Former switch', async () => {
		const f = createPersonFolder(api());
		f.reset(true);
		await f.load('p1');
		f.alias.value = ' zz9 ';
		expect(f.changes()).toEqual({ uni_alias: 'zz9' });
		f.alias.value = '';
		f.scanFormer.value = false;
		expect(f.changes()).toEqual({ uni_alias: null, scan_while_former: false });
	});

	it('sends nothing, and says why, when the values could not be read', async () => {
		const f = createPersonFolder(api({ get: vi.fn(async () => { throw new Error('x'); }) }));
		f.reset(true);
		await f.load('p1');
		expect(f.ready.value).toBe(false);
		expect(f.loadError.value).toContain('cannot be changed here');
		f.alias.value = 'abc';
		expect(f.changes()).toEqual({});
	});

	it('reads the alias like the database: a leading dot, one character and a slash are refused', () => {
		const f = createPersonFolder(api());
		for (const bad of ['.ab', 'a', 'a/b']) {
			f.alias.value = bad;
			expect(f.issue.value, bad).not.toBeNull();
		}
		f.alias.value = 'ab1cd';
		expect(f.issue.value).toBeNull();
		f.alias.value = '';
		expect(f.issue.value).toBeNull();
	});

	it('sets the fields after a person was created, by a PATCH of its own', async () => {
		const a = api();
		const f = createPersonFolder(a);
		f.reset(false);
		f.alias.value = ' ab1cd ';
		f.scanFormer.value = true;
		expect(await f.afterCreate('p-new', 'Ann Lee')).toBeNull();
		expect(a.patch).toHaveBeenCalledWith('/items/people/p-new', { uni_alias: 'ab1cd', scan_while_former: true });
	});

	it('does nothing after create when there is nothing to set', async () => {
		const a = api();
		const f = createPersonFolder(a);
		f.reset(false);
		expect(await f.afterCreate('p-new', 'Ann Lee')).toBeNull();
		expect(a.patch).not.toHaveBeenCalled();
	});

	it('a refused second request says the person was added and what failed; a duplicate names no one', async () => {
		const a = api({ patch: vi.fn(async () => { throw failure('Value for field "uni_alias" in collection "people" has to be unique.', 'RECORD_NOT_UNIQUE'); }) });
		const f = createPersonFolder(a);
		f.reset(false);
		f.alias.value = 'ab1cd';
		const message = await f.afterCreate('p-new', 'Ann Lee');
		expect(message).toBe('Ann Lee was added, but the folder settings were not saved: That alias is already used by another person. Aliases are compared without regard to case.');
		// the next Save is an edit of the person who now exists, and sends the change
		expect(f.ready.value).toBe(true);
		expect(f.changes()).toEqual({ uni_alias: 'ab1cd' });
	});

	it('when the server did not say who was added, the message says so', async () => {
		const f = createPersonFolder(api());
		f.reset(false);
		f.alias.value = 'ab1cd';
		expect(await f.afterCreate(undefined, 'Ann Lee')).toContain('The server did not say which person was added.');
	});
});
