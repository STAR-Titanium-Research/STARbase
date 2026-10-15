import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createAutoLink } from './useAutoLink';
import { createFakeInbox, foundFile } from './fakeInboxServer';

const autoLinked = (batch: string, at: string) => foundFile({ state: 'linked', link_kind: 'auto', link_batch_id: batch, decided_at: at, linked_label: 'S-1', linked_collection: 'physical_samples', linked_record_id: 'r' });
const refused = (status: number, message = 'no') => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message }] } } });

describe('createAutoLink', () => {
	it('loads the switch (off by default) and the recently auto-linked files only', async () => {
		const fake = createFakeInbox({ files: [autoLinked('b1', '2026-10-15T09:00:00Z'), foundFile({ state: 'linked', link_kind: 'manual', link_batch_id: 'b2' }), foundFile()] });
		const s = createAutoLink(fake.api);
		await s.load();
		expect(s.on.value).toBe(false);
		expect(s.recent.value.map((f) => f.link_batch_id)).toEqual(['b1']);
		expect(fake.calls.find((c) => c.path === '/d1-inbox/files')?.params).toMatchObject({ tab: 'linked', link_kind: 'auto' });
		expect(s.absent.value).toBe(false);
	});

	it('turns on and off over PUT and says so', async () => {
		const fake = createFakeInbox();
		const s = createAutoLink(fake.api);
		await s.load();
		expect(await s.set(true)).toBe(true);
		expect(s.on.value).toBe(true);
		expect(s.note.value).toContain('linked for you');
		expect(fake.calls.at(-1)).toMatchObject({ method: 'put', path: '/d1-inbox/prefs', body: { auto_link: true } });
		expect(await s.set(false)).toBe(true);
		expect(s.on.value).toBe(false);
		expect(s.note.value).toBe('Saved. Automatic linking is off.');
	});

	it('a failed save puts the switch back and shows the endpoint\'s words', async () => {
		const fake = createFakeInbox();
		const api: HostApi = { ...fake.api, put: vi.fn(async () => { throw refused(500, 'The server is busy.'); }) };
		const s = createAutoLink(api);
		await s.load();
		expect(await s.set(true)).toBe(false);
		expect(s.on.value).toBe(false);
		expect(s.error.value).toBe('The server is busy.');
		expect(s.saving.value).toBe(false);
	});

	it('undo removes the batch, refreshes the list and the counts', async () => {
		const fake = createFakeInbox({ files: [autoLinked('b1', '2026-10-15T09:00:00Z')] });
		const changed = vi.fn();
		const s = createAutoLink(fake.api, changed);
		await s.load();
		await s.undo('b1');
		expect(s.recent.value).toEqual([]);
		expect(s.note.value).toBe('Undone: 1 found file back in your Inbox.');
		expect(changed).toHaveBeenCalled();
		expect(fake.files[0].state).toBe('new');
	});

	it('a server with no d1-inbox leaves the section out, with no error', async () => {
		for (const status of [404, 403]) {
			const api = { get: vi.fn(async () => { throw refused(status); }) } as unknown as HostApi;
			const s = createAutoLink(api);
			await s.load();
			expect(s.absent.value).toBe(true);
			expect(s.error.value).toBe('');
		}
	});

	it('another failure of the first read is shown, and the section stays', async () => {
		const api = { get: vi.fn(async () => { throw refused(500, 'Down.'); }) } as unknown as HostApi;
		const s = createAutoLink(api);
		await s.load();
		expect(s.absent.value).toBe(false);
		expect(s.error.value).toBe('Down.');
	});
});
