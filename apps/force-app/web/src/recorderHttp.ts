// Shared plumbing for the typed recorder-backend clients (labampApi, nidaqApi).
import { getConfig } from './config';

// Read at call time, not captured: Settings > Connectivity can retarget the recorder at runtime.
export function recorderBase(): string { return getConfig().recorderUrl; }

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

// JSON body of an OK response; otherwise throw with the status and the start of the body text.
export async function readJson<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
	return res.json() as Promise<T>;
}

export interface RemoteBackupStates {
	/** false when no backup server is set up, so "no remote copies" is not a finding. */
	configured: boolean;
	/** Capture id -> backup_state ('complete' | 'interrupted' | 'streaming' | 'unknown') of the
	 *  copies still held on the server. A 'deleted' tombstone is dropped: it is only kept to undo the
	 *  local delete, so it is not a remote copy. */
	states: Map<string, string>;
}

/** The backup server's copies, via the recorder. Throws when the recorder answers non-OK or can't be
 *  reached — callers decide what "couldn't tell" means for them (it must not read as "no copy"). */
export async function fetchRemoteBackupStates(base: string): Promise<RemoteBackupStates> {
	const d = await readJson<{ configured?: boolean; sessions?: { id: string; backup_state?: string }[] }>(
		await fetch(`${base}/backup/remote-sessions`),
	);
	return {
		configured: d.configured !== false,
		states: new Map((d.sessions || []).filter((s) => s.backup_state !== 'deleted').map((s) => [s.id, s.backup_state || 'unknown'])),
	};
}
