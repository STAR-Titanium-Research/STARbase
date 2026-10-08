import { describe, expect, it } from 'vitest';
import { backupStateLabel, expiresIn, listState, localStatusLabel, prefillServerUrl, remoteCopyLabel, restoreBlockedReason, serverUrlToSave, type RemoteSession } from './backupLabels';

const base: RemoteSession = { id: '20260101_000000', raw_size_mb: 12 };
const NOW = 1_000_000 * 1000;

describe('expiresIn', () => {
	it('words the time left', () => {
		expect(expiresIn(null, NOW)).toBeNull();
		expect(expiresIn(1_000_000 - 5, NOW)).toBe('now');
		expect(expiresIn(1_000_000 + 30, NOW)).toBe('within a minute');
		expect(expiresIn(1_000_000 + 40 * 60, NOW)).toBe('in 40 min');
		expect(expiresIn(1_000_000 + 5.5 * 3600, NOW)).toBe('in 5.5h');
		expect(expiresIn(1_000_000 + 12 * 3600, NOW)).toBe('in 12h');
	});
});

describe('backupStateLabel', () => {
	it('relabels the server states', () => {
		expect(backupStateLabel({ ...base, backup_state: 'complete' }).text).toBe('Fully backed up');
		expect(backupStateLabel({ ...base, backup_state: 'interrupted' }).text).toBe('Backup interrupted (partial)');
		expect(backupStateLabel({ ...base, backup_state: 'deleted', expires_at: 1_000_000 + 3 * 3600 }, NOW).text)
			.toBe('Deleted locally — expires in 3h');
	});
	it('falls back to the raw state for an older backend', () => {
		expect(backupStateLabel({ ...base, state: 'complete' }).text).toBe('complete');
	});
});

describe('restore gating and local status', () => {
	it('blocks restore over a finalized local copy', () => {
		expect(restoreBlockedReason({ ...base, local_status: 'finalized', backup_state: 'complete' })).toMatch(/already saved/);
		expect(restoreBlockedReason({ ...base, local_status: 'missing', backup_state: 'complete' })).toBeNull();
		expect(restoreBlockedReason({ ...base, local_status: 'deleted', backup_state: 'deleted' })).toBeNull();
		expect(restoreBlockedReason({ ...base, backup_state: 'streaming' })).toMatch(/in progress/);
		expect(restoreBlockedReason({ ...base, local_status: 'incomplete', backup_state: 'interrupted' })).toMatch(/Recover it/);
	});
	it('describes the local copy', () => {
		expect(localStatusLabel({ ...base, local_status: 'finalized' })).toMatch(/saved on this machine/);
		expect(localStatusLabel({ ...base, local_status: 'deleted' })).toBeNull();
	});
});

describe('listState', () => {
	it('keeps not-loaded, error and empty apart', () => {
		expect(listState({ loaded: false, loading: false, error: '', count: 0 })).toBe('idle');
		expect(listState({ loaded: false, loading: true, error: '', count: 0 })).toBe('loading');
		expect(listState({ loaded: false, loading: false, error: 'x', count: 0 })).toBe('error');
		expect(listState({ loaded: true, loading: false, error: '', count: 0 })).toBe('empty');
		expect(listState({ loaded: true, loading: true, error: '', count: 2 })).toBe('ready');
	});
});

describe('remoteCopyLabel', () => {
	it('tells a full, a partial and a missing remote copy apart', () => {
		expect(remoteCopyLabel('complete')).toBe('remote copy exists');
		expect(remoteCopyLabel('interrupted')).toBe('partial remote copy');
		expect(remoteCopyLabel('unknown')).toBe('partial remote copy');
		expect(remoteCopyLabel(undefined)).toBe('no remote copy');
		expect(remoteCopyLabel(null)).toBe('no remote copy');
	});
});

describe('prefillServerUrl', () => {
	const SUG = 'https://d1-server.example/backup-ingest';
	it('offers the suggestion when no URL is saved', () => {
		expect(prefillServerUrl('', SUG)).toEqual({ url: SUG, suggested: true });
		expect(prefillServerUrl('  ', SUG)).toEqual({ url: SUG, suggested: true });
		expect(prefillServerUrl(undefined, SUG)).toEqual({ url: SUG, suggested: true });
	});
	it('keeps a URL that is already saved', () => {
		expect(prefillServerUrl('http://host:8210', SUG)).toEqual({ url: 'http://host:8210', suggested: false });
	});
	it('stays empty when the backend has no suggestion', () => {
		expect(prefillServerUrl('', undefined)).toEqual({ url: '', suggested: false });
		expect(prefillServerUrl('', '')).toEqual({ url: '', suggested: false });
	});
});

describe('serverUrlToSave', () => {
	const SUG = 'https://d1-server.example/backup-ingest';
	it('sends nothing for an untouched suggestion while backups are off', () => {
		expect(serverUrlToSave({ enabled: false, server_url: SUG }, true)).toBe('');
	});
	it('saves the suggestion once backups are enabled', () => {
		expect(serverUrlToSave({ enabled: true, server_url: SUG }, true)).toBe(SUG);
	});
	it('saves an edited or already saved URL, enabled or not', () => {
		expect(serverUrlToSave({ enabled: false, server_url: 'http://host:8210' }, false)).toBe('http://host:8210');
		expect(serverUrlToSave({ enabled: true, server_url: 'http://host:8210' }, false)).toBe('http://host:8210');
	});
});
