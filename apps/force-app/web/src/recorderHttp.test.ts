import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteBackupStates } from './recorderHttp';

const reply = (body: unknown, ok = true) =>
	vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => 'boom' })));

afterEach(() => vi.unstubAllGlobals());

describe('fetchRemoteBackupStates', () => {
	it('maps ids to backup_state, drops deleted tombstones and defaults to unknown', async () => {
		reply({ configured: true, sessions: [
			{ id: 'a', backup_state: 'complete' }, { id: 'b', backup_state: 'interrupted' },
			{ id: 'c', backup_state: 'deleted' }, { id: 'd' },
		] });
		const r = await fetchRemoteBackupStates('http://x');
		expect(r.configured).toBe(true);
		expect([...r.states]).toEqual([['a', 'complete'], ['b', 'interrupted'], ['d', 'unknown']]);
	});
	it('reports a missing backup server as not configured', async () => {
		reply({ configured: false, sessions: [] });
		expect((await fetchRemoteBackupStates('http://x')).configured).toBe(false);
	});
	it('throws on a non-OK answer so callers can treat it as "could not tell"', async () => {
		reply({}, false);
		await expect(fetchRemoteBackupStates('http://x')).rejects.toThrow(/500/);
	});
});
